'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { isValidMobile } = require('../fraud/fraudRules');
const { ipv6Prefix, inPrefix } = require('../fraud/ipPrefix');

/**
 * Risk scoring and data quality (SPEC §5.5).
 *
 * `score(orderDraft, context)` runs before a storefront order is saved and
 * returns `{ score, level, reasons, dataQuality }`. The level is only a
 * marker: nothing happens to the order unless the merchant switched on the
 * `high_risk` fraud rule. The weights are a starting point.
 *
 *   orderDraft: { contact: { fullName, phone, email }, shippingAddress: { addressLine } }
 *   context:    { workspaceId, country, visitor: { ip, ipCountry, isVpn },
 *                 secondsOnPage, network: { rate, total, spamReports }, transaction }
 */

const WEIGHTS = Object.freeze({
  invalid_phone: 40,
  suspicious_name: 20,
  weak_address: 15,
  foreign_ip: 25,
  vpn_ip: 25,
  too_fast: 20,
  ip_burst: 20,
  low_delivery_rate: 30,
  spam_report: 15,
  disposable_email: 10,
});
const SPAM_REPORTS_CAP = 45;
const FAST_SECONDS = 10;
const LEVELS = ['low', 'moderate', 'high'];

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', '10minutemail.com', 'tempmail.com',
  'temp-mail.org', 'yopmail.com', 'trashmail.com', 'throwawaymail.com', 'getnada.com', 'dispostable.com',
  'maildrop.cc', 'fakeinbox.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com', 'tempail.com', 'moakt.com',
]);

// Words no real name is made of. Arabic and English, matched on whole words.
const OFFENSIVE_WORDS = ['fuck', 'shit', 'bitch', 'asshole', 'test', 'asdf', 'qwerty', 'كلب', 'حمار', 'زفت', 'تجربه', 'تجربة'];

function levelOf(score) {
  if (score >= 60) return 'high';
  if (score >= 30) return 'moderate';
  return 'low';
}

function letters(text) {
  return String(text || '').replace(/[^\p{L}]/gu, '');
}

function words(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Shorter than 3 letters, keyboard mashing, one letter repeated, or a word no name holds. */
function isSuspiciousName(name) {
  const only = letters(name);
  if (only.length < 3) return true;
  if (/^(.)\1+$/u.test(only)) return true;
  if (words(name).some((w) => OFFENSIVE_WORDS.includes(w))) return true;
  // Latin with no vowel at all over 5+ letters ("sdfgh", "qwrtp").
  if (/^[a-z]{5,}$/i.test(only) && !/[aeiouy]/i.test(only)) return true;
  // The same 2–3 letter chunk over and over ("ababab", "asdasd").
  if (/^(.{2,3})\1{2,}$/u.test(only.toLowerCase())) return true;
  return false;
}

/** Shorter than 10 characters, or the same words said twice ("Aswan Governorate Aswan Governorate"). */
function isWeakAddress(addressLine) {
  const text = String(addressLine || '').trim();
  if (text.length < 10) return true;
  const list = words(text);
  if (list.length >= 2 && new Set(list).size <= Math.ceil(list.length / 2)) return true;
  return false;
}

function isDisposableEmail(email) {
  const domain = String(email || '').trim().toLowerCase().split('@')[1];
  return Boolean(domain && DISPOSABLE_DOMAINS.has(domain));
}

/**
 * Orders from this IP or this device in the last hour (orders_ws_ip_created_idx, orders_ws_device_created_idx).
 * An IPv6 address counts its whole /64 with IPV6_PREFIX_RULES_ENABLED (fraud/ipPrefix).
 */
async function ordersFromIpLastHour(workspaceId, ip, transaction, deviceId = null) {
  const prefix = ipv6Prefix(ip);
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  if (prefix) {
    // Every order of the hour that shares the device or has an IPv6 address; the /64 is compared here.
    const rows = await db.sequelize.query(
      `SELECT o.ip_address, o.device_id
         FROM orders o
        WHERE o.workspace_id = $workspaceId
          AND (o.ip_address LIKE '%:%' OR ($deviceId::varchar IS NOT NULL AND o.device_id = $deviceId))
          AND o.created_at >= $since::timestamptz`,
      { bind: { workspaceId, deviceId, since }, type: QueryTypes.SELECT, transaction }
    );
    return rows.filter((row) => (deviceId && row.device_id === deviceId) || inPrefix(prefix, row.ip_address)).length;
  }
  const [row] = await db.sequelize.query(
    `SELECT COUNT(*)::int AS count
       FROM orders o
      WHERE o.workspace_id = $workspaceId
        AND (o.ip_address = $ip OR ($deviceId::varchar IS NOT NULL AND o.device_id = $deviceId))
        AND o.created_at >= $since::timestamptz`,
    {
      bind: { workspaceId, ip: ip || null, deviceId, since },
      type: QueryTypes.SELECT,
      transaction,
    }
  );
  return row.count;
}

async function score(orderDraft, context = {}) {
  const { contact = {}, shippingAddress = null } = orderDraft || {};
  const { workspaceId, country = 'EG', visitor = {}, secondsOnPage = null, network = null, transaction } = context;
  const reasons = [];
  let total = 0;
  let dataQuality = 'good';
  const add = (reason, points = WEIGHTS[reason]) => {
    reasons.push(reason);
    total += points;
  };

  if (!isValidMobile(contact.phone, country)) {
    add('invalid_phone');
    dataQuality = 'low';
  }
  if (isSuspiciousName(contact.fullName)) {
    add('suspicious_name');
    dataQuality = 'low';
  }
  if (shippingAddress && isWeakAddress(shippingAddress.addressLine)) {
    add('weak_address');
    dataQuality = 'low';
  }
  if (visitor.ipCountry && String(visitor.ipCountry).toUpperCase() !== country) add('foreign_ip');
  if (visitor.isVpn) add('vpn_ip');
  if (typeof secondsOnPage === 'number' && secondsOnPage < FAST_SECONDS) add('too_fast');
  if (
    (visitor.ip || visitor.deviceId) &&
    workspaceId &&
    (await ordersFromIpLastHour(workspaceId, visitor.ip, transaction, visitor.deviceId || null)) >= 2
  ) {
    add('ip_burst');
  }
  if (network) {
    if (network.rate != null && network.total >= 3 && network.rate < 40) add('low_delivery_rate');
    if (network.spamReports > 0) add('spam_report', Math.min(SPAM_REPORTS_CAP, network.spamReports * WEIGHTS.spam_report));
  }
  if (isDisposableEmail(contact.email)) add('disposable_email');

  return { score: total, level: levelOf(total), reasons, dataQuality };
}

module.exports = { score, levelOf, WEIGHTS, LEVELS, isSuspiciousName, isWeakAddress, isDisposableEmail };
