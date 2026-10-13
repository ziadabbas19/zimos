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
// IPv6: unspecified, loopback, NAT64, unique-local, link-local, multicast,
// documentation.
[
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
].forEach(([address, prefix]) => blocked.addSubnet(address, prefix, 'ipv6'));

/** Whether an IP address is somewhere a webhook must never be sent. */
function isPrivateAddress(address) {
  const ip = String(address).replace(/^\[|\]$/g, '');
  if (net.isIPv4(ip)) return blocked.check(ip, 'ipv4');
  if (net.isIPv6(ip)) {
    // An IPv4 address written as IPv6 (::ffff:10.0.0.1) is that IPv4 address.
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return blocked.check(mapped[1], 'ipv4');
    return blocked.check(ip, 'ipv6');
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

module.exports = { checkUrl, isPrivateAddress, guardedLookup, BlockedAddressError, UNUSABLE_HOST_MESSAGE };
