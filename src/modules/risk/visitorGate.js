'use strict';

const crypto = require('crypto');
const net = require('net');
const { Op } = require('sequelize');
const db = require('../../db/models');
const { AppError } = require('../../core/errors/AppError');
const ipIntel = require('./ipIntel');
const { clientIp: clientIpOf } = require('../../core/middleware/clientIp');
const { ipv6Prefix, inPrefix } = require('../fraud/ipPrefix');

/**
 * Who is on the other end of a public store request, and whether the store
 * wants to see them at all (SPEC §5.1).
 *
 * A visitor is turned away when their IP is a blocked entry of scope `visit`,
 * or when it resolves to one of `fraud_rules.blocked_countries`. They get the
 * same 423 STORE_UNAVAILABLE a closed store answers, so the storefront shows
 * its "unavailable" page and nothing says they were singled out.
 */

const SECRET_HEADER = 'x-storefront-secret';
const CLIENT_IP_HEADER = 'x-storefront-client-ip';
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 10000;
const cache = new Map();

function parseIp(value) {
  if (typeof value !== 'string') return null;
  const ip = value.trim().toLowerCase().replace(/^::ffff:/, '');
  return net.isIP(ip) ? ip : null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

/**
 * The shopper's IP. Server-rendered pages reach the API from the storefront
 * server, which names the shopper in X-Storefront-Client-IP and proves itself
 * with X-Storefront-Secret (the same pair core/middleware/rateLimiters
 * trusts); a browser's own call carries the shopper's address (clientIp).
 */
function visitorIp(req) {
  if (!req) return null;
  const secret = process.env.STOREFRONT_PROXY_SECRET;
  const provided = req.headers && req.headers[SECRET_HEADER];
  if (secret && typeof provided === 'string' && crypto.timingSafeEqual(sha256(provided), sha256(secret))) {
    const forwarded = parseIp(req.headers[CLIENT_IP_HEADER]);
    if (forwarded) return forwarded;
  }
  return parseIp(clientIpOf(req));
}

/** `{ ip, ipCountry, isVpn }` for the fraud rules and the order row. */
async function describeVisitor(req) {
  const ip = visitorIp(req);
  if (!ip) return { ip: null, ipCountry: null, isVpn: false };
  const intel = await ipIntel.lookup(ip);
  return { ip, ipCountry: intel.country, isVpn: intel.isVpn || intel.isHosting };
}

function blockedCountries(workspace) {
  const rules = (workspace.settings && workspace.settings.fraud_rules) || {};
  return Array.isArray(rules.blocked_countries) ? rules.blocked_countries.map((c) => String(c).toUpperCase()) : [];
}

async function isBlocked(workspace, ip) {
  const key = `${workspace.id}:${ip}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.blocked;

  let blocked = Boolean(
    await db.BlockedEntry.findOne({
      where: { workspaceId: workspace.id, scope: 'visit', type: 'ip', value: ip },
      attributes: ['id'],
    })
  );
  // The same IPv6 /64 as a blocked address (IPV6_PREFIX_RULES_ENABLED, fraud/ipPrefix).
  const prefix = blocked ? null : ipv6Prefix(ip);
  if (prefix) {
    const entries = await db.BlockedEntry.findAll({
      where: { workspaceId: workspace.id, scope: 'visit', type: 'ip', value: { [Op.like]: '%:%' } },
      attributes: ['value'],
    });
    blocked = entries.some((entry) => inPrefix(prefix, entry.value));
  }
  if (!blocked) {
    const countries = blockedCountries(workspace);
    if (countries.length > 0) {
      const { country } = await ipIntel.lookup(ip);
      blocked = Boolean(country && countries.includes(country));
    }
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { blocked, expires: Date.now() + CACHE_TTL_MS });
  return blocked;
}

/** Forget what is cached for a store: its visit blocks or blocked countries changed. */
function forgetWorkspace(workspaceId) {
  for (const key of cache.keys()) if (key.startsWith(`${workspaceId}:`)) cache.delete(key);
}

/**
 * Called by resolvePublicWorkspace once the store is known. Throws the 423
 * for a blocked visitor; a staff preview is never blocked.
 */
async function refuseBlockedVisitor(req, workspace) {
  if (req.draftPreview) return;
  const ip = visitorIp(req);
  if (!ip) return;
  if (await isBlocked(workspace, ip)) {
    throw new AppError('STORE_UNAVAILABLE', 'This store is currently unavailable.', 423, {
      store: {
        name: workspace.name,
        slug: workspace.slug,
        defaultLocale: workspace.defaultLocale,
        logoUrl: workspace.logoUrl,
      },
    });
  }
}

module.exports = { visitorIp, describeVisitor, refuseBlockedVisitor, forgetWorkspace };
