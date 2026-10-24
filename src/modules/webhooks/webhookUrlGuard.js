'use strict';

const dns = require('dns');
const net = require('net');
const env = require('../../config/env');
const { ValidationError } = require('../../core/errors/AppError');

/**
 * A webhook URL is typed by a merchant, and then *this server* sends requests
 * to it. Left open, that is a way to make our server call whatever it can
 * reach and the merchant cannot: the database on the private network, the
 * cloud provider's metadata service (169.254.169.254, which hands out
 * credentials), an admin port on localhost. So:
 *
 *   - when the URL is saved, it must be https (http only where
 *     env.webhooks.allowPrivateUrls, i.e. outside production), carry no
 *     user:password, and not name a private address or an internal hostname
 *     outright — checkUrl()
 *   - when a request is sent, every address the hostname resolves to is
 *     checked again at connect time — guardedLookup(), passed to
 *     http(s).request as its DNS lookup. Checking only at save time would be
 *     beaten by a hostname that resolves somewhere public today and to
 *     127.0.0.1 tomorrow (DNS rebinding); checking in the lookup the socket
 *     actually uses leaves no gap between the check and the connection.
 *
 * Redirects are never followed (webhookSender.js), so a public URL cannot
 * bounce the request inward either.
 */

const blocked = new net.BlockList();
// IPv4: "this network", private, carrier-grade NAT, loopback, link-local
// (incl. cloud metadata), IETF protocol assignments, the documentation and
// benchmarking ranges, multicast and reserved.
[
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].forEach(([address, prefix]) => blocked.addSubnet(address, prefix, 'ipv4'));
// IPv6: unspecified, loopback, NAT64 (well-known and local-use), discard-only,
// Teredo and 6to4 (both carry an IPv4 address inside), unique-local,
// site-local (deprecated), link-local, multicast, documentation.
[
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fec0::', 10],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
].forEach(([address, prefix]) => blocked.addSubnet(address, prefix, 'ipv6'));

/**
 * An IPv6 address as its eight 16-bit groups, or null when it is not one.
 * Takes every spelling: "::" compression, an IPv4 tail (::ffff:10.0.0.1) and
 * a zone (%eth0).
 */
function ipv6Groups(address) {
  let text = String(address).toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  const dotted = text.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const b = dotted.slice(1).map(Number);
    if (b.some((n) => n > 255)) return null;
    text = `${text.slice(0, -dotted[0].length)}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 2 && fill < 1)) return null;
  const parts = [...head, ...Array(fill).fill('0'), ...tail];
  if (parts.length !== 8 || parts.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return parts.map((g) => parseInt(g, 16));
}

/** Whether an IP address is somewhere a webhook must never be sent. */
function isPrivateAddress(address) {
  const ip = String(address).replace(/^\[|\]$/g, '');
  if (net.isIPv4(ip)) return blocked.check(ip, 'ipv4');
  if (net.isIPv6(ip)) {
    const g = ipv6Groups(ip);
    if (!g) return true;
    // The first 80 bits zero: an IPv4 address in IPv6 clothing, however it is
    // spelled (::ffff:10.0.0.1, ::ffff:a00:1). Mapped (…:ffff:…): that IPv4
    // address decides. Compatible (::a.b.c.d, deprecated) or anything else in
    // ::/96: never a webhook target.
    if (g.slice(0, 5).every((n) => n === 0)) {
      if (g[5] === 0xffff) return blocked.check(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`, 'ipv4');
      if (g[5] === 0) return true;
    }
    return blocked.check(ip.split('%')[0], 'ipv6');
  }
  // Not an IP at all: nothing to connect to.
  return true;
}

const INTERNAL_HOSTNAME = /(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/i;

/**
 * Checks a URL a merchant is saving. Throws a ValidationError on `field`
 * naming the problem; returns the URL normalised by the WHATWG parser.
 * `allowHttp` also takes plain http:// (a logo is only read, never sent
 * anything); private addresses are refused either way.
 */
function checkUrl(value, field = 'url', { allowHttp = false, label = 'webhook URL' } = {}) {
  const invalid = (message) => new ValidationError([{ field, message }], `Invalid ${label}`);
  let url;
  try {
    url = new URL(value);
  } catch (err) {
    throw invalid('Must be a full URL, like https://example.com/zimos/webhooks');
  }
  const allowPrivate = env.webhooks.allowPrivateUrls;
  if (url.protocol !== 'https:' && !((allowPrivate || allowHttp) && url.protocol === 'http:')) {
    throw invalid('Must start with https://');
  }
  if (url.username || url.password) throw invalid('Must not contain a username or password');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  // "postgres.railway.internal." is the same host as without the dot, and the
  // name checks below would not see it: a name ending in a dot is refused.
  if (host.endsWith('.')) throw invalid('Must not end with a dot');
  if (!allowPrivate) {
    if (net.isIP(host) && isPrivateAddress(host)) throw invalid('Must be a public address');
    if (!net.isIP(host) && (INTERNAL_HOSTNAME.test(host) || !host.includes('.'))) {
      throw invalid('Must be a public hostname');
    }
  }
  return url.toString();
}

/*
 * What a caller is told when a hostname cannot be used, whichever happened: it
 * resolved to a private address, or it did not resolve. This text ends up in
 * front of the merchant (a delivery log, an import's answer), and told apart
 * the two would say which internal names exist without one ever being
 * reached. What happened is on the error (`reason`, `hostname`, `code`), for
 * this server's own logs; the message is the same and names neither.
 */
const UNUSABLE_HOST_MESSAGE = 'This address cannot be used: its hostname does not resolve to a public address';

class BlockedAddressError extends Error {
  constructor(hostname) {
    super(UNUSABLE_HOST_MESSAGE);
    this.name = 'BlockedAddressError';
    this.code = 'EWEBHOOKBLOCKED';
    this.reason = 'private_address';
    this.hostname = hostname;
  }
}

/** A name the resolver gave no address for: the same words, its own code. */
function unresolvedHostError(hostname, cause) {
  return Object.assign(new Error(UNUSABLE_HOST_MESSAGE), {
    code: (cause && cause.code) || 'ENOTFOUND',
    reason: 'unresolved',
    hostname,
  });
}

/**
 * A drop-in for dns.lookup, for http(s).request's `lookup` option, that
 * refuses to hand back any private address (unless allowPrivateUrls).
 * Answers in whichever shape the caller asked for — Node's connection
 * attempts sometimes ask for every address (`all: true`), sometimes one.
 */
function guardedLookup(hostname, options, callback) {
  const opts = typeof options === 'number' ? { family: options } : { ...(options || {}) };
  const wantsAll = Boolean(opts.all);
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(unresolvedHostError(hostname, err));
    const list = addresses || [];
    if (list.length === 0) return callback(unresolvedHostError(hostname));
    if (!env.webhooks.allowPrivateUrls && list.some((a) => isPrivateAddress(a.address))) {
      return callback(new BlockedAddressError(hostname));
    }
    if (wantsAll) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

/**
 * A URL whose host is an IP address is never looked up, so guardedLookup
 * never sees it: the sender asks here before connecting. Returns the error to
 * report, or null when the address may be used.
 */
function literalAddressError(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '');
  if (!net.isIP(host) || env.webhooks.allowPrivateUrls) return null;
  return isPrivateAddress(host) ? new BlockedAddressError(host) : null;
}

module.exports = { checkUrl, isPrivateAddress, guardedLookup, literalAddressError, BlockedAddressError, UNUSABLE_HOST_MESSAGE };
