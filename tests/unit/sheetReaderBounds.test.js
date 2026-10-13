'use strict';

const zlib = require('zlib');
const { parseXlsx, readSheet } = require('../../src/modules/catalog/importExport/sheetReader');

// The .xlsx reader of the product import (catalog/importExport/sheetReader),
// on buffers built here: no file, no database, no network. The parse runs on
// the request's own thread, so its time has to grow with the size of the
// sheet and no faster.

/** A zip of deflated text files, enough of the format for the reader. */
function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8');
    const data = zlib.deflateRawSync(raw);
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const SHEET = 'xl/worksheets/sheet1.xml';
const SHARED = 'xl/sharedStrings.xml';
const ONE_ROW = '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>';

const elapsedMs = (fn) => {
  const started = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
};

describe('xlsx reader: an ordinary sheet', () => {
  const sheet =
    '<?xml version="1.0"?><worksheet><cols><col min="1" max="3" width="20"/></cols><sheetData>' +
    '<row r="1" spans="1:4"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><t xml:space="preserve"> Blue shirt </t></is></c><c r="B2" s="2"><v>149.5</v></c><c r="C2" s="1"/><c r="D2" t="str"><f>A2&amp;B2</f><v>a &amp; b &lt;c&gt;</v></c></row>' +
    '<row r="3"/>' +
    '<row r="4"><c r="A4" t="s"><v>4</v></c><c r="D4"><v>7</v></c></row>' +
    '</sheetData><rowBreaks count="1"><brk id="3"/></rowBreaks></worksheet>';
  const shared =
    '<?xml version="1.0"?><sst count="5"><si><t>Name</t></si><si><t>Price</t></si><si><t>SKU</t></si><si><t>Notes</t></si>' +
    '<si><r><rPr><b/></rPr><t>Red</t></r><r><t xml:space="preserve"> hat</t></r></si></sst>';
  const buffer = zip({ [SHARED]: shared, [SHEET]: sheet });

  it('reads shared and inline strings, numbers, empty cells and gaps', () => {
    expect(parseXlsx(buffer)).toEqual([
      ['Name', 'Price', 'SKU', 'Notes'],
      [' Blue shirt ', '149.5', '', 'a & b <c>'],
      [],
      ['Red hat', '', '', '7'],
    ]);
  });

  it('gives rows keyed by the header, with the line each came from', () => {
    expect(readSheet(buffer, 'products.xlsx')).toEqual({
      header: ['name', 'price', 'sku', 'notes'],
      rows: [
        { __row: 2, name: 'Blue shirt', price: '149.5', sku: '', notes: 'a & b <c>' },
        { __row: 4, name: 'Red hat', price: '', sku: '', notes: '7' },
      ],
    });
  });

  it('does not take <col>, <cols> or <rowBreaks> for a cell or a row', () => {
    const rows = parseXlsx(zip({ [SHEET]: '<cols><col min="1"/></cols><sheetData><row r="1"><c r="A1"><v>x</v></c></row></sheetData><rowBreaks><brk/></rowBreaks>' }));
    expect(rows).toEqual([['x']]);
  });
});

describe('xlsx reader: opening tags with nothing to close them', () => {
  // A few kilobytes of upload inflate to this. The regular expressions this
  // replaced re-read the rest of the sheet at every opening tag: 128 KB of
  // "<row>" took about 3 seconds, and each doubling four times longer.
  const SIZE = 8 * 1024 * 1024;
  const BUDGET_MS = 200;
  const repeated = (token) => token.repeat(Math.floor(SIZE / token.length));

  const cases = [
    ['rows that never close', { [SHEET]: repeated('<row>') }],
    ['shared strings that never close', { [SHARED]: repeated('<si>'), [SHEET]: ONE_ROW }],
    ['rows of cells of values that never close', { [SHEET]: repeated('<row><c r="A1"><v>') }],
    ['rows of inline strings that never close', { [SHEET]: repeated('<row><c r="A1" t="inlineStr"><is><t>') }],
    ['one row of cells that never close', { [SHEET]: `<row>${repeated('<c r="A1">')}</row>` }],
    ['one cell of text runs that never close', { [SHEET]: `<row><c r="A1" t="inlineStr">${repeated('<t>')}</c></row>` }],
    ['one cell of values that never close', { [SHEET]: `<row><c r="A1">${repeated('<v>')}</c></row>` }],
    ['a row tag that never ends', { [SHEET]: `<row ${repeated('r="1" ')}` }],
  ];

  it.each(cases)(`%s: ${SIZE / 1024 / 1024} MB is read within ${BUDGET_MS} ms`, (_name, files) => {
    const buffer = zip(files);
    // A few kilobytes on the wire.
    expect(buffer.length).toBeLessThan(64 * 1024);
    let rows;
    const took = elapsedMs(() => {
      rows = parseXlsx(buffer);
    });
    expect(Array.isArray(rows)).toBe(true);
    expect(took).toBeLessThan(BUDGET_MS);
  });

  it('reads what came before the tag that never closes', () => {
    const rows = parseXlsx(zip({ [SHEET]: `<row r="1"><c r="A1"><v>kept</v></c></row>${repeated('<row>')}` }));
    expect(rows).toEqual([['kept']]);
  });

  it('still stops at the row limit', () => {
    const many = '<row r="1"><c r="A1"><v>1</v></c></row>'.repeat(5002);
    expect(() => parseXlsx(zip({ [SHEET]: many }))).toThrow(/more than 5000 rows/);
  });
});
