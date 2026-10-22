'use strict';

const Joi = require('joi');
const joiEmail = require('../../core/utils/joiEmail');
const { normalizePhone } = require('../../core/utils/phone');

/**
 * What the console may save in each group of the platform settings, and the
 * checks behind it. Every field is named in the schemas below: the validator
 * strips anything else (stripUnknown), and a field that looks like a secret is
 * refused outright before that (`findSecrets`).
 *
 * Text the sites show is plain text, never HTML: tags are dropped, control and
 * direction-override characters removed, and the sites render it as text.
 */

/** The groups, in the console's order. */
const GROUPS = Object.freeze(['contact', 'social', 'company', 'footer', 'email']);
/** The groups the public endpoint sends; `email` stays on the server. */
const PUBLIC_GROUPS = Object.freeze(['contact', 'social', 'company', 'footer']);

const SOCIAL_PLATFORMS = Object.freeze(['instagram', 'facebook', 'tiktok', 'youtube', 'x', 'linkedin', 'whatsapp', 'email']);

/**
 * The domains each platform's link may point at: the domain itself or one of
 * its subdomains (www., m.). This is the allowlist to edit when a platform
 * adds a domain; the client's copy is PLATFORM_DOMAINS in
 * packages/ui/src/social-links/links.ts (keep the two the same). WhatsApp is
 * a wa.me chat link with a number, nothing else.
 */
const SOCIAL_DOMAINS = Object.freeze({
  instagram: Object.freeze(['instagram.com']),
  facebook: Object.freeze(['facebook.com', 'fb.com']),
  tiktok: Object.freeze(['tiktok.com']),
  youtube: Object.freeze(['youtube.com', 'youtu.be']),
  x: Object.freeze(['x.com', 'twitter.com']),
  linkedin: Object.freeze(['linkedin.com']),
  whatsapp: Object.freeze(['wa.me']),
});

const LIMITS = Object.freeze({
  email: 254,
  url: 500,
  platformName: 60,
  legalName: 120,
  registration: 80,
  taxRegistration: 40,
  address: 200,
  hours: 80,
  tagline: 160,
  rights: 120,
  senderName: 70,
  signature: 500,
});

/** One plain address: no display name, no second recipient, no headers. The client's rule (links.ts EMAIL_ADDRESS). */
const EMAIL_ADDRESS = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

const isControl = (code) => code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0);
// Bidirectional overrides and isolates (U+202A-U+202E, U+2066-U+2069) and the zero-width ones (U+200B-U+200F):
// they can make a name read as something else.
const isHiddenFormat = (code) => (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);

/** Text as the sites will show it: no tags, no control or hidden characters, spaces collapsed. */
function cleanText(value, { multiline = false } = {}) {
  const withoutTags = String(value).replace(/<[^>]*>/g, '');
  const kept = [...withoutTags.replace(/\r\n?/g, '\n')]
    .filter((char) => {
      const code = char.charCodeAt(0);
      if (char === '\n') return multiline;
      if (char === '\t') return true;
      return !isControl(code) && !isHiddenFormat(code);
    })
    .join('');
  if (!multiline) return kept.replace(/\s+/g, ' ').trim();
  return kept
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A plain-text field: cleaned, then held to `max` characters. `required`: empty after cleaning is refused. */
function plainText(max, { multiline = false, required = false } = {}) {
  // allow('') would let an exact '' skip the checks below, so only an optional field allows it.
  return (required ? Joi.string() : Joi.string().allow(''))
    .max(max * 4)
    .custom((value, helpers) => {
      const cleaned = cleanText(value, { multiline });
      if (required && !cleaned) return helpers.message(`${helpers.state.path.join('.')} must not be empty`);
      if (cleaned.length > max) return helpers.message(`${helpers.state.path.join('.')} must be at most ${max} characters`);
      return cleaned;
    });
}

/** The same text in both languages the sites speak. */
const localized = (max, opts) => Joi.object({ ar: plainText(max, opts).required(), en: plainText(max, opts).required() });

/** A phone number, stored in international form (+ and 10-15 digits); a local Egyptian number gets +20. */
const phone = Joi.string()
  .max(40)
  .custom((value, helpers) => {
    const digits = normalizePhone(value, '20');
    if (!digits || !/^[1-9][0-9]{9,14}$/.test(digits)) return helpers.message('phone must be a phone number, e.g. +201012345678 or 01012345678');
    return `+${digits}`;
  });

const hasSpaceOrControl = (value) => /\s/.test(value) || [...value].some((char) => isControl(char.charCodeAt(0)));

/**
 * The link to keep for `platform`, or why it is refused. `email` takes
 * `mailto:` with one address and nothing else; every other platform takes
 * `https:` on its own domain, with no user, password or port; WhatsApp is a
 * wa.me link to a number (country code first, 8-15 digits, no + or leading
 * zero) with at most a prefilled `text`. `javascript:`, `data:` and every
 * other scheme are refused.
 */
function checkSocialUrl(platform, raw) {
  const value = String(raw).trim();
  if (hasSpaceOrControl(value)) return { ok: false, message: 'must not contain spaces or control characters' };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (platform === 'email') {
    const match = /^mailto:(.+)$/i.exec(value);
    if (!match) return { ok: false, message: 'must be a mailto: address' };
    if (!EMAIL_ADDRESS.test(match[1]) || match[1].length > LIMITS.email) return { ok: false, message: 'must be one email address after mailto:' };
    return { ok: true, href: `mailto:${match[1].toLowerCase()}` };
  }
  if (!scheme || scheme[1].toLowerCase() !== 'https') return { ok: false, message: 'must start with https:// (no other scheme is allowed)' };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, message: 'must be a valid link' };
  }
  if (parsed.username || parsed.password || parsed.port) return { ok: false, message: 'must not hold a user, a password or a port' };
  const host = parsed.hostname.toLowerCase();
  const isOn = (domain) => host === domain || host.endsWith(`.${domain}`);
  if (!SOCIAL_DOMAINS[platform].some(isOn)) return { ok: false, message: `must be on ${SOCIAL_DOMAINS[platform].join(' or ')}` };
  if (platform === 'whatsapp') {
    if (host !== 'wa.me') return { ok: false, message: 'must be a https://wa.me/ link' };
    if (!/^\/[1-9][0-9]{7,14}$/.test(parsed.pathname)) return { ok: false, message: 'must be https://wa.me/ followed by the number with its country code (8-15 digits, no + or leading 0)' };
    if (parsed.hash || [...parsed.searchParams.keys()].some((key) => key !== 'text')) return { ok: false, message: 'may carry a prefilled ?text= only' };
  }
  return { ok: true, href: parsed.href };
}

const socialLink = Joi.object({
  platform: Joi.string()
    .valid(...SOCIAL_PLATFORMS)
    .required(),
  url: Joi.string().allow('', null).max(LIMITS.url),
  enabled: Joi.boolean().required(),
}).custom((link, helpers) => {
  const url = typeof link.url === 'string' ? link.url.trim() : '';
  if (!url) {
    if (link.enabled) return helpers.message(`${link.platform}: a link that is on needs a url`);
    return { platform: link.platform, url: null, enabled: false };
  }
  const checked = checkSocialUrl(link.platform, url);
  if (!checked.ok) return helpers.message(`${link.platform}: the link ${checked.message}`);
  return { platform: link.platform, url: checked.href, enabled: link.enabled };
});

const SCHEMAS = Object.freeze({
  // Both required: the policy pages' text names them ({email} and {phone}, apps/marketing).
  contact: Joi.object({
    supportEmail: joiEmail().max(LIMITS.email).lowercase().required(),
    phone: phone.required(),
    address: localized(LIMITS.address, { required: true }).required(),
    hours: localized(LIMITS.hours, { required: true }).required(),
  }),
  social: Joi.object({
    links: Joi.array().items(socialLink).max(SOCIAL_PLATFORMS.length).required(),
  }).custom((value, helpers) => {
    const seen = new Set();
    for (const link of value.links) {
      if (seen.has(link.platform)) return helpers.message(`${link.platform} is listed twice`);
      seen.add(link.platform);
    }
    return value;
  }),
  company: Joi.object({
    platformName: plainText(LIMITS.platformName, { required: true }).required(),
    legalName: localized(LIMITS.legalName, { required: true }).required(),
    registration: localized(LIMITS.registration, { required: true }).required(),
    taxRegistration: plainText(LIMITS.taxRegistration, { required: true }).required(),
  }),
  footer: Joi.object({
    tagline: localized(LIMITS.tagline, { required: true }).required(),
    rights: localized(LIMITS.rights, { required: true }).required(),
  }),
  email: Joi.object({
    // The display name only: the address stays EMAIL_FROM_ADDRESS. No quotes, angle brackets or line breaks
    // (the rule of a store's own sender name, notifications/orderEmailSender.js).
    senderName: Joi.string()
      .trim()
      .min(1)
      .max(LIMITS.senderName)
      .pattern(/^[^"<>\r\n]*$/)
      .required(),
    signature: localized(LIMITS.signature, { multiline: true }).required(),
    footer: Joi.object({
      showSupportEmail: Joi.boolean().required(),
      showSocialLinks: Joi.boolean().required(),
    }).required(),
  }),
});

/** A whole group as the console sends it; `{ value }` cleaned, or `{ error }` with Joi's details. */
function validateGroup(group, value) {
  const { error, value: cleaned } = SCHEMAS[group].required().validate(value, { abortEarly: false, stripUnknown: true });
  return error ? { error } : { value: cleaned };
}

// ---- Secrets: never stored here ---------------------------------------------

/** A field named like one of these is refused, wherever it sits in the body. */
const SECRET_NAME = /(secret|passw(or)?d|passwd|pwd|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|credential|bearer|auth[_-]?key|signing[_-]?key|webhook[_-]?key)/i;

/** A value that looks like one of these is refused, in any field. */
const SECRET_VALUES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // a JWT
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/, // payment providers' keys
  /\bAKIA[0-9A-Z]{16}\b/, // AWS
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, // GitHub
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, // a user and password inside a link
  /\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S+/i,
];

/** A long run of letters and digits mixed, outside a link: a key pasted where text belongs. */
function looksLikeRandomToken(text) {
  const outsideLinks = text.replace(/\b(https?:\/\/|mailto:)\S+/gi, ' ');
  return (outsideLinks.match(/[A-Za-z0-9+/=_-]{40,}/g) || []).some((run) => /[0-9]/.test(run) && /[A-Za-z]/.test(run));
}

/**
 * Where the body holds a secret: a field named like one, or a value that looks
 * like a key, a token or a password. `[{ field, message }]`, empty when none.
 */
function findSecrets(body, path = [], depth = 0, found = []) {
  if (depth > 6 || body === null || body === undefined) return found;
  if (typeof body === 'string') {
    if (SECRET_VALUES.some((pattern) => pattern.test(body)) || looksLikeRandomToken(body)) {
      found.push({ field: path.join('.') || 'body', message: 'looks like a secret (a key, a token or a password): platform settings never hold one' });
    }
    return found;
  }
  if (Array.isArray(body)) {
    body.forEach((item, index) => findSecrets(item, [...path, index], depth + 1, found));
    return found;
  }
  if (typeof body === 'object') {
    for (const [key, value] of Object.entries(body)) {
      if (SECRET_NAME.test(key)) {
        found.push({ field: [...path, key].join('.'), message: 'a secret, a key or a password is never stored in platform settings' });
        continue;
      }
      findSecrets(value, [...path, key], depth + 1, found);
    }
  }
  return found;
}

module.exports = {
  GROUPS,
  PUBLIC_GROUPS,
  SOCIAL_PLATFORMS,
  SOCIAL_DOMAINS,
  LIMITS,
  SCHEMAS,
  cleanText,
  checkSocialUrl,
  validateGroup,
  findSecrets,
};
