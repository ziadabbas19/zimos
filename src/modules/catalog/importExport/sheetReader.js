'use strict';

const zlib = require('zlib');

/*
 * Reads a spreadsheet upload into rows of strings, with no dependency: CSV
 * (comma, semicolon or tab; quoted fields; a UTF-8 BOM) and .xlsx (the first
 * sheet; shared and inline strings, numbers). An .xlsx is a zip of XML files;
 * only what a product sheet needs is understood — no formulas, no styles, no
 * dates.
 */

const MAX_ROWS = 5000;

class SheetError extends Error {}

// ------------------------------------------------------------------- CSV --

function detectDelimiter(text) {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of firstLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && counts[ch] !== undefined) counts[ch] += 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function parseCsv(buffer) {
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delimiter = detectDelimiter(text);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length > MAX_ROWS + 1) throw new SheetError(`The file has more than ${MAX_ROWS} rows`);
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ------------------------------------------------------------------ XLSX --

/** The files of a zip, by name, inflated on demand. Reads the central directory. */
function unzip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SheetError('This is not a valid .xlsx file');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new SheetError('This is not a valid .xlsx file');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    files.set(name, { method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return {
    has: (name) => files.has(name),
    names: () => [...files.keys()],
    read(name) {
      const entry = files.get(name);
      if (!entry) return null;
      // Sheets are text; 50 MB inflated is far past any product list and stops a zip bomb.
      if (entry.uncompressedSize > 50 * 1024 * 1024) throw new SheetError('The spreadsheet is too large');
      const local = entry.localOffset;
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + entry.compressedSize);
      if (entry.method === 0) return data.toString('utf8');
      if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: 50 * 1024 * 1024 }).toString('utf8');
      throw new SheetError('This .xlsx uses a compression this importer cannot read');
    },
  };
}

const decodeXml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&');

/*
 * Every <name …>…</name> (or <name …/>) of `xml` in order, as { attrs, body },
 * walked forward once. A regular expression with a lazy "anything up to the
 * closing tag" starts that search again at every opening tag: on XML that has
 * the opening tags and no closing tag it reads the rest of the file once per
 * tag, which for a sheet of a few megabytes is hours on the one thread every
 * request shares. Here each character is looked at a fixed number of times,
 * and an opening tag with nothing to close it ends the walk: nothing after it
 * can be an element either.
 */
const TAG_NAME_END = new Set([' ', '\t', '\r', '\n', '/', '>']);

function* elements(xml, name) {
  const open = `<${name}`;
  const close = `</${name}>`;
  let at = 0;
  for (;;) {
    const start = xml.indexOf(open, at);
    if (start === -1) return;
    const afterName = start + open.length;
    // <c, not <col or <cfRule.
    if (!TAG_NAME_END.has(xml[afterName])) {
      at = afterName;
      continue;
    }
    const tagEnd = xml.indexOf('>', afterName);
    if (tagEnd === -1) return;
    if (xml[tagEnd - 1] === '/') {
      yield { attrs: xml.slice(afterName, tagEnd - 1), body: null };
      at = tagEnd + 1;
      continue;
    }
    const end = xml.indexOf(close, tagEnd + 1);
    if (end === -1) return;
    yield { attrs: xml.slice(afterName, tagEnd), body: xml.slice(tagEnd + 1, end) };
    at = end + close.length;
  }
}

/** The text of every <t> inside a fragment (a shared string or an inline string). */
function textOf(xml) {
  let text = '';
  for (const t of elements(xml, 't')) if (t.body !== null) text += decodeXml(t.body);
  return text;
}

/** "BC12" → zero-based column index. */
function columnIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    if (ch < 'A' || ch > 'Z') break;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

function parseXlsx(buffer) {
  const zip = unzip(buffer);
  const shared = [];
  const sharedXml = zip.read('xl/sharedStrings.xml');
  if (sharedXml) {
    for (const si of elements(sharedXml, 'si')) shared.push(si.body === null ? '' : textOf(si.body));
  }
  const sheetName =
    (zip.has('xl/worksheets/sheet1.xml') && 'xl/worksheets/sheet1.xml') ||
    zip.names().find((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name));
  const sheet = sheetName && zip.read(sheetName);
  if (!sheet) throw new SheetError('The spreadsheet has no sheet');

  const rows = [];
  // A row with no cells (<row …/>) is a blank line of the file.
  for (const rowElement of elements(sheet, 'row')) {
    const row = [];
    for (const c of elements(rowElement.body || '', 'c')) {
      const attrs = c.attrs;
      const body = c.body || '';
      const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1];
      const type = (attrs.match(/t="([^"]+)"/) || [])[1];
      const v = elements(body, 'v').next().value;
      const raw = v && v.body !== null ? v.body : undefined;
      let value = '';
      if (type === 's') value = shared[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = textOf(body);
      else if (raw !== undefined) value = decodeXml(raw);
      const index = ref ? columnIndex(ref) : row.length;
      while (row.length < index) row.push('');
      row[index] = value;
    }
    rows.push(row);
    if (rows.length > MAX_ROWS + 1) throw new SheetError(`The file has more than ${MAX_ROWS} rows`);
  }
  return rows;
}

/**
 * Rows as objects keyed by the header row's names (lower-cased, spaces to
 * underscores). Blank rows are dropped; `__row` is the line number in the
 * file, for the error report.
 */
function readSheet(buffer, filename = '') {
  const isZip = buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  const rows = isZip || /\.xlsx$/i.test(filename) ? parseXlsx(buffer) : parseCsv(buffer);
  if (rows.length === 0) throw new SheetError('The file is empty');
  const header = rows[0].map((h) => String(h).trim().toLowerCase().replace(/\s+/g, '_'));
  const out = [];
  rows.slice(1).forEach((cells, i) => {
    if (cells.every((cell) => String(cell ?? '').trim() === '')) return;
    const record = { __row: i + 2 };
    header.forEach((name, col) => {
      if (name) record[name] = String(cells[col] ?? '').trim();
    });
    out.push(record);
  });
  return { header, rows: out };
}

module.exports = { readSheet, parseCsv, parseXlsx, SheetError, MAX_ROWS };
