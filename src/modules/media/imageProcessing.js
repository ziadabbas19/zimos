'use strict';

const logger = require('../../core/utils/logger');
const { AppError } = require('../../core/errors/AppError');

/*
 * Server-side image processing (sharp / libvips) for every image anyone
 * uploads: the merchant's media library and the photos shoppers attach to an
 * order. Two things it guarantees, whatever the browser did or did not do:
 *
 *   - no metadata leaves with the file: EXIF (GPS position, camera serial,
 *     capture time), XMP, IPTC and comments are dropped. The picture is first
 *     turned the way its EXIF orientation says, so dropping the tag does not
 *     leave a phone photo lying on its side;
 *   - the bytes are a real image: a file sharp cannot decode is refused, so a
 *     polyglot or a truncated upload never reaches storage.
 *
 * Merchant images keep their format; uploads to the library are scaled down
 * to MEDIA_MAX_DIMENSION on their long side and re-encoded at
 * MEDIA_JPEG_QUALITY, small ones (icons) excepted. The library's 5 MB cap is
 * on what is sent. Shopper photos are resized and compressed until they fit
 * CUSTOMER_MAX_OUTPUT_BYTES. An animated or static GIF is never re-encoded —
 * that would flatten or re-palette it — its comment and XMP blocks are cut out
 * of the byte stream instead (stripGifMetadata).
 *
 * sharp is loaded on first use, not at require time: a deploy whose native
 * binary failed to install still boots and says so in the log
 * (imageProcessingStatus), instead of taking the whole API down.
 */

const CUSTOMER_MAX_DIMENSION = 2400;
const CUSTOMER_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
// Decoding bombs: a tiny file that claims gigapixels.
const MAX_INPUT_PIXELS = 60 * 1000 * 1000;

let sharpModule;
let sharpError = null;

function loadSharp() {
  if (sharpModule !== undefined) return sharpModule;
  try {
    // eslint-disable-next-line global-require
    sharpModule = require('sharp');
  } catch (err) {
    sharpModule = null;
    sharpError = err;
    logger.error(`Image processing unavailable: sharp failed to load (${err.message})`);
  }
  return sharpModule;
}

/** One boot-log line: which libvips this process runs, or why there is none. */
function imageProcessingStatus() {
  const sharp = loadSharp();
  if (!sharp) return `unavailable — ${sharpError ? sharpError.message : 'sharp not installed'}`;
  return `sharp ${sharp.versions.sharp} (libvips ${sharp.versions.vips})`;
}

function requireSharp() {
  const sharp = loadSharp();
  if (!sharp) {
    throw new AppError('IMAGE_PROCESSING_UNAVAILABLE', 'Image processing is temporarily unavailable', 503);
  }
  return sharp;
}

const unreadable = () => new AppError('IMAGE_UNREADABLE', 'The image could not be read. Try another photo.', 422);

// ---------------------------------------------------------------------------
// GIF: strip metadata blocks without touching the frames
// ---------------------------------------------------------------------------

/**
 * Walks a GIF's block structure and drops comment extensions and every
 * application extension except the animation-loop ones (NETSCAPE2.0 /
 * ANIMEXTS1.0), which is where XMP rides. Frames, palettes and timing are
 * copied byte for byte. Anything unexpected throws: a GIF we cannot parse is
 * one we will not store.
 */
function stripGifMetadata(buffer) {
  const at = (i) => {
    if (i >= buffer.length) throw unreadable();
    return buffer[i];
  };
  const header = buffer.toString('latin1', 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') throw unreadable();
  const out = [];
  let i = 6;
  // Logical screen descriptor (7 bytes) and, when flagged, the global colour table.
  const packed = at(10);
  i = 13;
  if (packed & 0x80) i += 3 * 2 ** ((packed & 0x07) + 1);
  out.push(buffer.subarray(0, i));

  // Data sub-blocks: length byte, bytes, ... terminated by a zero length.
  const skipSubBlocks = (from) => {
    let p = from;
    for (;;) {
      const size = at(p);
      p += 1;
      if (size === 0) return p;
      p += size;
    }
  };

  for (;;) {
    const introducer = at(i);
    if (introducer === 0x3b) {
      out.push(buffer.subarray(i, i + 1));
      break;
    }
    if (introducer === 0x21) {
      const label = at(i + 1);
      const end = skipSubBlocks(i + 2);
      let keep = label === 0xf9 || label === 0x01; // graphic control, plain text
      if (label === 0xff) {
        const appId = buffer.toString('latin1', i + 3, i + 3 + 11);
        keep = appId === 'NETSCAPE2.0' || appId === 'ANIMEXTS1.0';
      }
      if (keep) out.push(buffer.subarray(i, end));
      i = end;
      continue;
    }
    if (introducer === 0x2c) {
      // Image descriptor (10 bytes), optional local colour table, LZW min code size, data.
      const flags = at(i + 9);
      let p = i + 10;
      if (flags & 0x80) p += 3 * 2 ** ((flags & 0x07) + 1);
      p += 1;
      const end = skipSubBlocks(p);
      out.push(buffer.subarray(i, end));
      i = end;
      continue;
    }
    throw unreadable();
  }
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// Merchant images (media library)
// ---------------------------------------------------------------------------

// At or under this on the long side a picture is an icon or a favicon: it is
// never resized or re-compressed beyond the metadata strip.
const SMALL_IMAGE_EDGE = 512;
// The quality a picture keeps when it is not being shrunk (and the one
// scripts/strip-media-exif.js has always used).
const KEEP_QUALITY = 90;

/**
 * Re-encodes a merchant upload in its own format with no metadata, turned
 * upright. `detected` is mediaService's content-sniffed signature. Returns the
 * new bytes; the mime type and extension do not change.
 *
 * With `maxDimension`, a picture over SMALL_IMAGE_EDGE is also scaled down to
 * fit it (never up) and JPEG/WebP are encoded at `quality`; PNG stays
 * lossless. Without it (the EXIF script), only the metadata goes.
 */
async function processMerchantImage(buffer, detected, { maxDimension, quality } = {}) {
  if (detected.mime === 'image/gif') return stripGifMetadata(buffer);
  const sharp = requireSharp();
  const open = () => sharp(buffer, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS });
  try {
    let pipeline = open().rotate();
    let lossy = KEEP_QUALITY;
    if (maxDimension) {
      const { width = 0, height = 0 } = await open().metadata();
      if (Math.max(width, height) > SMALL_IMAGE_EDGE) {
        pipeline = pipeline.resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true });
        lossy = quality || KEEP_QUALITY;
      }
    }
    if (detected.mime === 'image/jpeg') return await pipeline.jpeg({ quality: lossy, mozjpeg: true }).toBuffer();
    if (detected.mime === 'image/png') return await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
    if (detected.mime === 'image/webp') return await pipeline.webp({ quality: lossy }).toBuffer();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw unreadable();
  }
  throw unreadable();
}

// ---------------------------------------------------------------------------
// Shopper photos (customer uploads)
// ---------------------------------------------------------------------------

/**
 * A shopper's photo, made safe to keep: upright, no metadata, at most
 * CUSTOMER_MAX_DIMENSION on its long side, JPEG (or WebP when it has
 * transparency worth keeping), compressed step by step until it fits
 * CUSTOMER_MAX_OUTPUT_BYTES. Only JPEG, PNG and WebP are taken — decided from
 * the bytes by the caller. Anything sharp cannot finish is refused.
 */
async function processCustomerImage(buffer) {
  const sharp = requireSharp();
  let meta;
  try {
    meta = await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch {
    throw unreadable();
  }
  const keepAlpha = Boolean(meta.hasAlpha) && meta.format !== 'jpeg';

  let dimension = CUSTOMER_MAX_DIMENSION;
  const qualities = [82, 72, 62, 52];
  try {
    for (let round = 0; round < 6; round += 1) {
      for (const quality of qualities) {
        const pipeline = sharp(buffer, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS })
          .rotate()
          .resize({ width: dimension, height: dimension, fit: 'inside', withoutEnlargement: true });
        const encoded = keepAlpha
          ? pipeline.webp({ quality, alphaQuality: 90 })
          : pipeline.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true });
        const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
        if (data.length <= CUSTOMER_MAX_OUTPUT_BYTES) {
          return {
            buffer: data,
            mime: keepAlpha ? 'image/webp' : 'image/jpeg',
            ext: keepAlpha ? 'webp' : 'jpg',
            width: info.width,
            height: info.height,
          };
        }
      }
      dimension = Math.round(dimension * 0.75);
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw unreadable();
  }
  throw new AppError('IMAGE_TOO_LARGE', 'The photo could not be made small enough. Try a smaller one.', 413);
}

module.exports = {
  loadSharp,
  imageProcessingStatus,
  processMerchantImage,
  processCustomerImage,
  stripGifMetadata,
  CUSTOMER_MAX_DIMENSION,
  CUSTOMER_MAX_OUTPUT_BYTES,
  SMALL_IMAGE_EDGE,
};
