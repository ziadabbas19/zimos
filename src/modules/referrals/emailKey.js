'use strict';

/**
 * The key a referral code's once-per-email rule compares (redemptionService):
 * lowercase, the "+tag" of the local part dropped (every provider that takes
 * plus addressing delivers a+1@x to a@x), and for Gmail the dots dropped too
 * and googlemail.com read as gmail.com. So a.b+1@Gmail.com, ab@gmail.com and
 * ab@googlemail.com are one person. Other providers keep their dots: for them
 * a.b and ab can be two mailboxes.
 *
 * Migration 725 keeps its own copy of this rule for the backfill.
 */
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

function emailKey(email) {
  const raw = String(email || '').trim().toLowerCase();
  const at = raw.lastIndexOf('@');
  if (at <= 0) return raw || null;
  let local = raw.slice(0, at);
  let domain = raw.slice(at + 1);
  if (GMAIL_DOMAINS.has(domain)) domain = 'gmail.com';
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

module.exports = { emailKey };
