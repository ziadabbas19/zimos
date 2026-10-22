'use strict';

const crypto = require('crypto');
const net = require('net');
const { ipKeyGenerator } = require('express-rate-limit');
const db = require('../../../db/models');
const logger = require('../../../core/utils/logger');

/**
 * The visitor's IP as the guard keeps it: never the address, a 16-hex-digit
 * HMAC of it keyed with a random salt for the UTC day (traffic_salts). Same
 * network, same day → same value, so the console can see many sessions behind
 * one connection; the next day the salt is different, and two days later it is
 * deleted (analytics/jobs.js), after which nobody — us included — can tell
 * which IP a stored hash came from. IPv6 is hashed per /56, the unit the rate
 * limits count by (one household or phone gets one prefix).
 *
 * Shown in the console only; the merchant dashboard never returns it.
 */

let cached = { day: null, salt: null };
let loading = null;

const utcDay = () => new Date().toISOString().slice(0, 10);

/** The IP as the rate limits key it (IPv4-mapped unwrapped, IPv6 by /56), or null. */
function ipKey(value) {
  if (typeof value !== 'string') return null;
  let ip = value.trim();
  if (/^::ffff:/i.test(ip) && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  return net.isIP(ip) ? ipKeyGenerator(ip) : null;
}

async function saltFor(day) {
  if (cached.day === day) return cached.salt;
  if (!loading) {
    loading = (async () => {
      await db.sequelize.query('INSERT INTO traffic_salts (day, salt, created_at) VALUES (:day, :salt, NOW()) ON CONFLICT (day) DO NOTHING', {
        replacements: { day, salt: crypto.randomBytes(32).toString('hex') },
      });
      const row = await db.TrafficSalt.findByPk(day, { attributes: ['salt'], raw: true });
      cached = { day, salt: row.salt };
      return row.salt;
    })().finally(() => {
      loading = null;
    });
  }
  return loading;
}

/** The day's hash of `ip`, or null when there is no usable IP or no salt could be had. Never throws. */
async function hashIp(ip) {
  const key = ipKey(ip);
  if (!key) return null;
  try {
    const salt = await saltFor(utcDay());
    return crypto.createHmac('sha256', salt).update(key).digest('hex').slice(0, 16);
  } catch (err) {
    logger.warn(`[traffic] no salt for the IP hash: ${err.message}`);
    return null;
  }
}

/** Tests: forget the cached salt. */
function reset() {
  cached = { day: null, salt: null };
}

module.exports = { hashIp, ipKey, reset };
