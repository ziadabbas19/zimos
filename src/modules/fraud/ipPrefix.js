'use strict';

const net = require('net');
const { ipKeyGenerator } = require('express-rate-limit');
const env = require('../../config/env');

/**
 * One IPv6 shopper is a /64, not one address: their provider hands their
 * line a /64 and the device moves inside it from one connection to the next,
 * so a rule that compares whole addresses misses the same shopper's second
 * order. With IPV6_PREFIX_RULES_ENABLED the IP checks of the store's rules
 * compare IPv6 addresses by their /64 — the IP blocklist (orders, codes,
 * visits), min_minutes_between_cod_orders_per_ip and the risk score's
 * ip_burst. IPv4 addresses are compared whole, as before; so is everything
 * while the flag is off.
 *
 * Stored addresses are not rewritten: an IPv6 address is matched against
 * every IPv6 value of the store in the window and compared here.
 */

const PREFIX_BITS = 64;

/** The /64 an IPv6 address sits in ("2001:db8:1:2::/64"); null for IPv4, an invalid value, or with the flag off. */
function ipv6Prefix(ip) {
  if (!env.ipRules.ipv6Prefix || typeof ip !== 'string') return null;
  const address = ip.trim();
  if (!net.isIPv6(address)) return null;
  try {
    return ipKeyGenerator(address, PREFIX_BITS);
  } catch {
    return null;
  }
}

/** Whether a stored address falls in `prefix` (from ipv6Prefix). */
const inPrefix = (prefix, stored) => Boolean(prefix) && ipv6Prefix(stored) === prefix;

module.exports = { PREFIX_BITS, ipv6Prefix, inPrefix };
