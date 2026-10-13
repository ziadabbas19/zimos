'use strict';

const { csvCell } = require('../../src/core/utils/csvCell');

// The lost-orders export (core/utils/csvCell): what a shopper typed into a
// name or an address must never open as a formula in the merchant's spreadsheet.
describe('csvCell', () => {
  it('prefixes a value a spreadsheet would run as a formula', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+201000000000')).toBe("'+201000000000");
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('prefixes and quotes a value that starts with a tab or a carriage return', () => {
    expect(csvCell('\t=HYPERLINK("http://x","y")')).toBe('"\'\t=HYPERLINK(""http://x"",""y"")"');
    expect(csvCell('\t=1+1')).toBe('"\'\t=1+1"');
    expect(csvCell('\r=1+1')).toBe('"\'\r=1+1"');
  });

  it('quotes a tab anywhere in the cell, so it cannot split the column', () => {
    expect(csvCell('Cairo\tGiza')).toBe('"Cairo\tGiza"');
  });

  it('leaves ordinary text alone and quotes commas, quotes and line breaks', () => {
    expect(csvCell('Mona Ali')).toBe('Mona Ali');
    expect(csvCell('12 Tahrir St, Cairo')).toBe('"12 Tahrir St, Cairo"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line 1\nline 2')).toBe('"line 1\nline 2"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(1250)).toBe('1250');
  });
});
