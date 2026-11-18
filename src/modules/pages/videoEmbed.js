'use strict';

/*
 * What a merchant may put in a Video section: a link from a known video host, a
 * direct video file, or the <iframe> code such a host hands out. Only the address
 * is ever read from that code. Nothing the merchant pastes is stored or drawn as
 * markup.
 *
 * The dashboard and the storefront read addresses the same way
 * (packages/api-client/src/videoEmbed.ts): keep the three in step.
 */

const MAX_SOURCE = 4000;
const MAX_URL = 1000;
const FILE_PATH = /\.(mp4|webm|m4v)$/i;
const ASPECTS = ['16:9', '9:16', '1:1', '4:3'];

const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (whole, body) => {
    if (body[0] !== '#') return ENTITIES[body.toLowerCase()] ?? whole;
    const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

/** The attributes of the first <iframe> tag; null when there is none. */
function iframeAttributes(markup) {
  const open = /<iframe(?=[\s/>])/i.exec(markup);
  if (!open) return null;
  const attributes = {};
  let at = open.index + open[0].length;
  const isSpace = (c) => c !== undefined && /[\s/]/.test(c);
  while (at < markup.length && markup[at] !== '>') {
    if (isSpace(markup[at])) {
      at += 1;
      continue;
    }
    const start = at;
    while (at < markup.length && !/[\s/>=]/.test(markup[at])) at += 1;
    const name = markup.slice(start, at).toLowerCase();
    while (isSpace(markup[at])) at += 1;
    let value = '';
    if (markup[at] === '=') {
      at += 1;
      while (markup[at] !== undefined && /\s/.test(markup[at])) at += 1;
      const quote = markup[at];
      if (quote === '"' || quote === "'") {
        const end = markup.indexOf(quote, at + 1);
        const stop = end === -1 ? markup.length : end;
        value = markup.slice(at + 1, stop);
        at = stop + 1;
      } else {
        const begin = at;
        while (at < markup.length && !/[\s>]/.test(markup[at])) at += 1;
        value = markup.slice(begin, at);
      }
    } else if (start === at) {
      at += 1;
    }
    if (name && !(name in attributes)) attributes[name] = decodeEntities(value);
  }
  return attributes;
}

const fail = (problem) => ({ ok: false, problem });
const frame = (provider, src, id) => ({ ok: true, kind: 'iframe', provider, src, id });

const segmentsOf = (url) => url.pathname.split('/').filter(Boolean);
const clean = (value, pattern) => (typeof value === 'string' && pattern.test(value) ? value : null);

const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,20}$/;
function youtube(url, host) {
  const parts = segmentsOf(url);
  let id = null;
  if (host === 'youtu.be') id = parts[0];
  else if (parts[0] === 'watch') id = url.searchParams.get('v');
  else if (['embed', 'shorts', 'live', 'v'].includes(parts[0])) id = parts[1];
  if (!clean(id, YOUTUBE_ID)) return fail('unreadable');
  const start = /^(\d{1,6})s?$/.exec(url.searchParams.get('start') ?? url.searchParams.get('t') ?? '');
  return frame('youtube', `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start[1]}` : ''}`, id);
}

function vimeo(url, host) {
  const parts = segmentsOf(url);
  const at = host === 'player.vimeo.com' ? (parts[0] === 'video' ? 1 : -1) : parts.findIndex((part) => /^\d{6,12}$/.test(part));
  const id = at >= 0 ? clean(parts[at], /^\d{6,12}$/) : null;
  if (!id) return fail('unreadable');
  const hash = clean(url.searchParams.get('h') ?? parts[at + 1], /^[0-9a-f]{6,20}$/i);
  return frame('vimeo', `https://player.vimeo.com/video/${id}${hash ? `?h=${hash}` : ''}`, id);
}

function facebook(url, host) {
  const parts = segmentsOf(url);
  if (host === 'fb.watch') {
    const code = clean(parts[0], /^[A-Za-z0-9_-]{4,20}$/);
    if (!code) return fail('unreadable');
    return facebookFrame(`https://fb.watch/${code}/`, code);
  }
  if (parts[0] === 'plugins') {
    let inner;
    try {
      inner = new URL(url.searchParams.get('href') ?? '');
    } catch (err) {
      return fail('unreadable');
    }
    const innerHost = hostOf(inner);
    if (inner.protocol !== 'https:' || parts[1] !== 'video.php' || !isFacebook(innerHost) || segmentsOf(inner)[0] === 'plugins') return fail('unreadable');
    return facebook(inner, innerHost);
  }
  if (parts[0] === 'watch') {
    const id = clean(url.searchParams.get('v'), /^\d{5,20}$/);
    return id ? facebookFrame(`https://www.facebook.com/watch/?v=${id}`, id) : fail('unreadable');
  }
  const marker = parts.findIndex((part) => ['videos', 'reel', 'v', 'r'].includes(part));
  const id = marker >= 0 ? clean(parts[marker + 1], /^[A-Za-z0-9_-]{5,40}$/) : null;
  if (!id) return fail('unreadable');
  const safePath = parts.slice(0, marker + 2).every((part) => /^[\w.-]+$/.test(part));
  return safePath ? facebookFrame(`https://www.facebook.com/${parts.slice(0, marker + 2).join('/')}/`, id) : fail('unreadable');
}

function facebookFrame(page, id) {
  return frame('facebook', `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(page)}&show_text=false`, id);
}

function instagram(url) {
  const parts = segmentsOf(url);
  const marker = parts.findIndex((part) => ['reel', 'reels', 'p', 'tv'].includes(part));
  const code = marker >= 0 ? clean(parts[marker + 1], /^[A-Za-z0-9_-]{5,20}$/) : null;
  if (!code) return fail('unreadable');
  return frame('instagram', `https://www.instagram.com/${parts[marker] === 'p' ? 'p' : 'reel'}/${code}/embed/`, code);
}

function tiktok(url, host) {
  const parts = segmentsOf(url);
  if (host !== 'tiktok.com' || parts[0] === 't') return fail('short-link');
  const marker = parts.findIndex((part) => ['video', 'v1', 'v2', 'v', 'embed'].includes(part));
  const raw = marker >= 0 ? parts.slice(marker + 1).find((part) => /^\d{10,25}(\.html)?$/.test(part)) : null;
  if (!raw) return fail('unreadable');
  const id = raw.replace('.html', '');
  return frame('tiktok', `https://www.tiktok.com/player/v1/${id}`, id);
}

function wistia(url) {
  const parts = segmentsOf(url);
  const marker = parts.findIndex((part) => part === 'medias' || part === 'iframe');
  const id = marker >= 0 ? clean((parts[marker + 1] ?? '').replace(/\.(jsonp?|html)$/, ''), /^[a-z0-9]{6,20}$/i) : null;
  return id ? frame('wistia', `https://fast.wistia.net/embed/iframe/${id}`, id) : fail('unreadable');
}

function loom(url) {
  const parts = segmentsOf(url);
  const id = ['share', 'embed'].includes(parts[0]) ? clean(parts[1], /^[A-Za-z0-9]{16,40}$/) : null;
  return id ? frame('loom', `https://www.loom.com/embed/${id}`, id) : fail('unreadable');
}

function drive(url) {
  const parts = segmentsOf(url);
  const raw = parts[0] === 'file' && parts[1] === 'd' ? parts[2] : url.searchParams.get('id');
  const id = clean(raw, /^[A-Za-z0-9_-]{10,80}$/);
  return id ? frame('drive', `https://drive.google.com/file/d/${id}/preview`, id) : fail('unreadable');
}

const hostOf = (url) => url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
const isFacebook = (host) => ['facebook.com', 'm.facebook.com', 'web.facebook.com', 'fb.watch'].includes(host);

function providerFor(url, host) {
  if (['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'youtu.be'].includes(host)) return youtube(url, host);
  if (host === 'vimeo.com' || host === 'player.vimeo.com') return vimeo(url, host);
  if (isFacebook(host)) return facebook(url, host);
  if (host === 'instagram.com') return instagram(url);
  if (host === 'tiktok.com' || host === 'vm.tiktok.com' || host === 'vt.tiktok.com') return tiktok(url, host);
  if (/(^|\.)wistia\.(com|net)$/.test(host)) return wistia(url);
  if (host === 'loom.com') return loom(url);
  if (host === 'drive.google.com') return drive(url);
  return null;
}

function readAddress(address) {
  // Browsers drop control characters inside an address, so "java\nscript:" is still a script.
  let value = address.replace(/[\u0000-\u001F\u007F]+/g, '').trim();
  if (value === '') return fail('empty');
  if (/\s/.test(value)) return fail('unreadable');
  if (value.startsWith('//')) value = `https:${value}`;
  if (value.startsWith('/')) {
    return FILE_PATH.test(value.split(/[?#]/)[0]) ? { ok: true, kind: 'file', provider: 'file', src: value } : fail('unknown-host');
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `https://${value}`;
  let url;
  try {
    url = new URL(value);
  } catch (err) {
    return fail('unreadable');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail('unsafe');
  if (url.username || url.password) return fail('unsafe');
  const host = hostOf(url);
  const known = url.port ? null : providerFor(url, host);
  if (known) return known;
  if (FILE_PATH.test(url.pathname)) {
    url.protocol = 'https:';
    return { ok: true, kind: 'file', provider: 'file', src: url.toString() };
  }
  return fail('unknown-host');
}

/** Reads a pasted link or <iframe> code into the one address the store may load. */
function parseVideoSource(input) {
  if (typeof input !== 'string') return fail('empty');
  const text = input.trim();
  if (text === '') return fail('empty');
  if (text.length > MAX_SOURCE) return fail('unreadable');
  if (!text.includes('<')) return readAddress(decodeEntities(text));
  if (/<\s*script/i.test(text)) return fail('unsafe');
  const attributes = iframeAttributes(text);
  if (!attributes) return fail('unsafe');
  if (!attributes.src) return fail('unreadable');
  return readAddress(attributes.src);
}

const PROBLEM_MESSAGE = {
  unsafe: 'is not allowed: paste a video link or the code from a video site / غير مسموح: الصق رابط فيديو أو الكود من موقع الفيديو',
  'unknown-host':
    'must come from YouTube, Vimeo, Facebook, Instagram, TikTok, Wistia, Loom or Google Drive, or be an MP4 file / لازم يكون من يوتيوب أو فيميو أو فيسبوك أو إنستجرام أو تيك توك أو ويستيا أو لوم أو جوجل درايف، أو ملف MP4',
  'short-link': 'is a short link: open the video and copy its full address / ده رابط مختصر: افتح الفيديو وانسخ الرابط الكامل',
  unreadable: 'could not be read as a video address / مش قادرين نقرأ رابط الفيديو ده',
};

/** The page-tree rule for a stored video address: "" is "not chosen yet", markup is never stored. */
function videoUrlRule(value) {
  if (typeof value !== 'string' || value.length > MAX_URL) return `must be a string of at most ${MAX_URL} characters`;
  if (value.trim() === '') return null;
  if (value.includes('<')) return PROBLEM_MESSAGE.unsafe;
  const parsed = parseVideoSource(value);
  return parsed.ok ? null : PROBLEM_MESSAGE[parsed.problem];
}

/** The props of the `video` element. */
function propRules(check) {
  return {
    url: videoUrlRule,
    title: check.plainText(200),
    caption: check.plainText(400),
    aspect: check.oneOf(...ASPECTS),
    autoplay: check.bool,
    maxWidth: check.oneOf('container', 'full'),
    rounded: check.bool,
  };
}

module.exports = { parseVideoSource, videoUrlRule, propRules, ASPECTS };
