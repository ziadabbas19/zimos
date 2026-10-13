'use strict';

/**
 * One CSV cell for a file staff open in a spreadsheet. A value that would run
 * as a formula (it starts with = + - @, tab or carriage return) is prefixed
 * with an apostrophe: a shopper can type anything into a name or an address.
 * A cell holding a quote, a comma, a tab or a line break is quoted.
 */
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\t\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

module.exports = { csvCell };
