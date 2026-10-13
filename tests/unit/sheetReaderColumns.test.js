'use strict';

// The import route with what it hands the sheet to stubbed out: this file
// loads no models, and the sheets are built in memory.
const mockTransfer = { fromSheet: jest.fn(), createImport: jest.fn() };
jest.mock('../../src/modules/catalog/importExport/productTransfer', () => mockTransfer);
jest.mock('../../src/modules/audit/auditService', () => ({ recordAudit: jest.fn().mockResolvedValue() }));
jest.mock('../../src/core/middleware/subscriptionGuard', () => ({ requireCreationAllowed: (req, res, next) => next() }));

const zlib = require('zlib');
const express = require('express');
const request = require('supertest');
const { errorHandler } = require('../../src/core/middleware/errorHandler');
const { parseCsv, parseXlsx, readSheet, SheetError, MAX_COLUMNS } = require('../../src/modules/catalog/importExport/sheetReader');
const importRoutes = require('../../src/modules/catalog/importExport/routes');

// The product import's sheet reader (catalog/importExport/sheetReader): a sheet
// may be as wide as MAX_COLUMNS and no wider. Without that bound one cell in a
// far column, or a wide header over many rows, costs memory out of all
// proportion to the upload.

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
const xlsx = (sheetXml) => zip({ 'xl/worksheets/sheet1.xml': sheetXml });

/** 1 → "A", 27 → "AA", 500 → "SF". */
function columnName(number) {
  let name = '';
  for (let n = number; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

const TOO_WIDE = `The file has more than ${MAX_COLUMNS} columns`;
const refusal = (fn) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
};
const elapsedMs = (fn) => {
  const started = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
};

describe('sheet reader: how wide a sheet may be', () => {
  it('is 500 columns', () => {
    expect(MAX_COLUMNS).toBe(500);
    expect(columnName(500)).toBe('SF');
  });

  describe('.xlsx', () => {
    const oneCellAt = (ref) => xlsx(`<sheetData><row r="1"><c r="${ref}"><v>1</v></c></row></sheetData>`);

    it('reads a cell in the last column allowed', () => {
      const rows = parseXlsx(oneCellAt('SF1'));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveLength(500);
      expect(rows[0][499]).toBe('1');
    });

    it.each([['SG1'], ['ZZ1'], ['XFD1'], ['ZZZZZ1'], ['ZZZZZZZZZZZZ1'], [`${'Z'.repeat(5000)}1`]])('refuses a cell at %s', (ref) => {
      const err = refusal(() => parseXlsx(oneCellAt(ref)));
      expect(err).toBeInstanceOf(SheetError);
      expect(err.message).toBe(TOO_WIDE);
    });

    it('refuses a far cell at once, without building the row up to it', () => {
      // 12 letters is a column number past 10^16: padding a row to it never ends.
      const buffer = oneCellAt('ZZZZZZZZZZZZ1');
      expect(buffer.length).toBeLessThan(1024);
      let err = null;
      const took = elapsedMs(() => {
        err = refusal(() => parseXlsx(buffer));
      });
      expect(err.message).toBe(TOO_WIDE);
      expect(took).toBeLessThan(200);
    });

    it('counts cells that name no column, too', () => {
      const cells = (count) => '<c><v>1</v></c>'.repeat(count);
      expect(parseXlsx(xlsx(`<row>${cells(500)}</row>`))[0]).toHaveLength(500);
      expect(refusal(() => parseXlsx(xlsx(`<row>${cells(501)}</row>`))).message).toBe(TOO_WIDE);
    });

    it('refuses a far cell on any row, not only the header', () => {
      const sheet = '<row r="1"><c r="A1"><v>name</v></c></row><row r="2"><c r="A2"><v>Shirt</v></c><c r="ZZ2"><v>stray</v></c></row>';
      expect(refusal(() => parseXlsx(xlsx(sheet))).message).toBe(TOO_WIDE);
    });
  });

  describe('.csv', () => {
    const line = (count, delimiter = ',') => Array.from({ length: count }, (_, i) => `c${i}`).join(delimiter);

    it.each([[','], [';'], ['\t']])('reads 500 columns and refuses 501, separated by %j', (delimiter) => {
      expect(parseCsv(Buffer.from(`${line(500, delimiter)}\n`))[0]).toHaveLength(500);
      const err = refusal(() => parseCsv(Buffer.from(`${line(501, delimiter)}\n`)));
      expect(err).toBeInstanceOf(SheetError);
      expect(err.message).toBe(TOO_WIDE);
    });

    it('refuses a wide row below a narrow header', () => {
      expect(refusal(() => parseCsv(Buffer.from(`name,price\n${line(501)}\n`))).message).toBe(TOO_WIDE);
    });

    it('does not count a delimiter inside a quoted cell', () => {
      const quoted = `"${line(600)}"`;
      const rows = parseCsv(Buffer.from(`name,notes\nShirt,${quoted}\n`));
      expect(rows[1]).toHaveLength(2);
      expect(rows[1][1].split(',')).toHaveLength(600);
    });

    it('refuses a header of thousands of columns before any row is read against it', () => {
      // 4000 named columns over 5000 rows took 2.3 s and about 1 GB before the limit.
      const buffer = Buffer.from(`${line(4000)}\n${'x\n'.repeat(5000)}`);
      let err = null;
      const took = elapsedMs(() => {
        err = refusal(() => readSheet(buffer, 'products.csv'));
      });
      expect(err).toBeInstanceOf(SheetError);
      expect(err.message).toBe(TOO_WIDE);
      expect(took).toBeLessThan(200);
    });
  });

  it('an ordinary sheet reads as before', () => {
    expect(readSheet(Buffer.from('Name,Price,SKU\nBlue shirt,149.5,BS-1\n'), 'products.csv')).toEqual({
      header: ['name', 'price', 'sku'],
      rows: [{ __row: 2, name: 'Blue shirt', price: '149.5', sku: 'BS-1' }],
    });
  });
});

describe('POST /products/import with a sheet that is too wide', () => {
  const small = express();
  small.use((req, res, next) => {
    req.user = { id: 'user-1' };
    req.tenant = { workspaceId: '11111111-1111-4111-8111-111111111111', hasPermission: () => true };
    next();
  });
  small.use(importRoutes);
  small.use(errorHandler);
  const upload = (buffer, filename) => request(small).post('/products/import').attach('file', buffer, filename);

  beforeEach(() => {
    mockTransfer.fromSheet.mockReset().mockReturnValue([{ name: 'Blue shirt' }]);
    mockTransfer.createImport.mockReset().mockResolvedValue({ id: 'import-1', total: 1 });
  });

  it.each([
    ['a .csv', Buffer.from(`${Array.from({ length: 501 }, (_, i) => `c${i}`).join(',')}\nx\n`), 'products.csv'],
    ['an .xlsx', xlsx('<sheetData><row r="1"><c r="ZZZZZ1"><v>1</v></c></row></sheetData>'), 'products.xlsx'],
  ])('answers 422 on the file for %s, and starts no import', async (_name, buffer, filename) => {
    const res = await upload(buffer, filename);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual([{ field: 'file', message: TOO_WIDE }]);
    expect(mockTransfer.fromSheet).not.toHaveBeenCalled();
    expect(mockTransfer.createImport).not.toHaveBeenCalled();
  });

  it('still takes an ordinary sheet', async () => {
    const res = await upload(Buffer.from('Name,Price\nBlue shirt,149.5\n'), 'products.csv');
    expect(res.status).toBe(202);
    expect(mockTransfer.fromSheet).toHaveBeenCalledWith({ header: ['name', 'price'], rows: [{ __row: 2, name: 'Blue shirt', price: '149.5' }] });
  });
});
