'use strict';

const { cell } = require('../../src/modules/orders/orderExportService');

describe('orderExportService.cell', () => {
  it.each([
    ['=1+1', "'=1+1"],
    ['+201001234567', "'+201001234567"],
    ['-5', "'-5"],
    ['@SUM(A1:A2)', "'@SUM(A1:A2)"],
    ['\tTab', "'\tTab"],
    ['\rCR', "\"'\rCR\""],
  ])('writes %j as text: %j', (input, expected) => {
    expect(cell(input)).toBe(expected);
  });

  it('quotes a value with a comma, a quote or a line break, doubling its quotes', () => {
    expect(cell('a,b')).toBe('"a,b"');
    expect(cell('say "hi"')).toBe('"say ""hi"""');
    expect(cell('line\nbreak')).toBe('"line\nbreak"');
    expect(cell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
  });

  it('leaves ordinary values alone, and writes nothing for null', () => {
    expect(cell('Cairo')).toBe('Cairo');
    expect(cell('251.00')).toBe('251.00');
    expect(cell(3)).toBe('3');
    expect(cell('a=b')).toBe('a=b');
    expect(cell(null)).toBe('');
    expect(cell(undefined)).toBe('');
  });
});
