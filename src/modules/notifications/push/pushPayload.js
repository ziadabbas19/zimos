'use strict';

/**
 * What a device notification carries, built from an allowlist only.
 *
 * The push service sees when and how much is sent, and the device shows the
 * text on a locked screen, so nothing about a customer (name, phone, address,
 * what they wrote) ever goes in. The bell's own title, body and data are never
 * copied here: they may name the customer (merchantNotificationEvents.js).
 *
 *  - The payload has exactly the fields of FIELDS, and nothing else.
 *  - Its title and body come from TEXTS, one entry per type, filled only with
 *    the params that entry lists, each checked by its rule. Any other value a
 *    caller passes (a whole order, say) is ignored.
 *  - `url` is a path inside the app ("/orders/…"), never another site.
 *
 * A new type is one more entry in TEXTS, its params named with their rules.
 */

const FIELDS = ['v', 'type', 'title', 'body', 'url', 'tag', 'count'];

// Far under the 4096 bytes a push service carries once encrypted.
const MAX_BYTES = 3000;

const PARAM_RULES = {
  // A whole number, shown as it is (an order number, a count).
  integer: (value) => (Number.isSafeInteger(value) && value >= 0 ? String(value) : null),
};

// The dashboard's Arabic is Modern Standard Arabic.
const TEXTS = {
  'push.test': {
    params: {},
    ar: { title: 'Zimos', body: 'هذا إشعار تجريبي: إشعارات الجهاز تعمل.' },
    en: { title: 'Zimos', body: 'This is a test notification: device notifications work.' },
  },
};

const LOCALES = ['ar', 'en'];

function fill(template, params, rules) {
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    const rule = rules[name] && PARAM_RULES[rules[name]];
    const value = rule ? rule(params[name]) : null;
    if (value === null) throw new Error(`Push text param "${name}" is missing or not allowed`);
    return value;
  });
}

// A path inside the app: one leading slash, no scheme, no host, no backslash.
const SAFE_PATH = /^\/(?![/\\])[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/;
const SAFE_TAG = /^[A-Za-z0-9:._-]{1,64}$/;

/**
 * The JSON string sent to the device. `type` must be one of TEXTS; `params`
 * is read only for the names TEXTS lists for it.
 */
function build(type, { locale, params = {}, url = '/', tag, count = 1 } = {}) {
  const text = TEXTS[type];
  if (!text) throw new Error(`Unknown push type "${type}"`);
  const words = text[LOCALES.includes(locale) ? locale : 'ar'];
  const safeParams = params && typeof params === 'object' ? params : {};
  const payload = {
    v: 1,
    type,
    title: fill(words.title, safeParams, text.params),
    body: fill(words.body, safeParams, text.params),
    url: typeof url === 'string' && url.length <= 300 && SAFE_PATH.test(url) ? url : '/',
    tag: typeof tag === 'string' && SAFE_TAG.test(tag) ? tag : type,
    count: Number.isSafeInteger(count) && count >= 1 && count <= 999 ? count : 1,
  };
  const json = JSON.stringify(payload, FIELDS);
  if (Buffer.byteLength(json) > MAX_BYTES) throw new Error(`Push payload of "${type}" is over ${MAX_BYTES} bytes`);
  return json;
}

module.exports = { build, FIELDS, TEXTS, MAX_BYTES };
