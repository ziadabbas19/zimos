'use strict';

const { cell } = require('../../src/modules/orders/orderExportService');

// One CSV cell of the orders export: a value that a spreadsheet would run as
// a formula starts with an apostrophe; a plain number (an amount, "-5",
// "+201001234567") is left a number, which runs nothing.

describe('order export CSV cell', () => {
  it.each([
    ['=HYPERLINK("http://evil.example","x")', `"'=HYPERLINK(""http://evil.example"",""x"")"`],
    ['+cmd|/C calc!A0', "'+cmd|/C calc!A0"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1:A9)', "'@SUM(A1:A9)"],
    ['\t=1+1', `'\t=1+1`],
    ['=1+1,2', `"'=1+1,2"`],
  ])('escapes %j', (value, expected) => {
    expect(cell(value)).toBe(expected);
  });

  it.each([
    ['125.50', '125.50'],
    ['-5', '-5'],
    ['+201001234567', '+201001234567'],
    ['محمد علي', 'محمد علي'],
    [null, ''],
  ])('leaves %j as it is', (value, expected) => {
    expect(cell(value)).toBe(expected);
  });
});
