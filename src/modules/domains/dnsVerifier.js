'use strict';

const dns = require('dns');

/**
 * One DNS TXT lookup — kept in its own tiny module so tests can mock it and so
 * there is exactly one place to swap the resolver if ever needed.
 * Returns `string[][]` (node's shape: an array of records, each an array of
 * string chunks). Throws on NXDOMAIN / no records (ENOTFOUND / ENODATA).
 */
async function lookupTxt(hostname) {
  return dns.promises.resolveTxt(hostname);
}

module.exports = { lookupTxt };
