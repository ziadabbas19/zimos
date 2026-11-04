'use strict';

const env = require('../../config/env');

/**
 * `Cache-Control` for the public catalogue's GETs (the store, its products, its
 * collections, its policies, its sitemap): nothing in them belongs to one
 * shopper. With STOREFRONT_API_CACHE_ENABLED exactly "true" they answer
 * `public, max-age=0, s-maxage=<STOREFRONT_API_S_MAXAGE, 30>,
 * stale-while-revalidate=<STOREFRONT_API_SWR, 60>` and `Vary: X-Store-Locale`,
 * the same shape the store's pages have at the edge (the storefront's
 * lib/edgeCache.ts). `max-age=0`: a browser keeps nothing, and asks with the
 * ETag, so an unchanged answer costs a 304.
 *
 * A shared cache holds these only if told to (no rule at Cloudflare caches this
 * API today), and storefrontCache's purge names store hosts, not the API's, so
 * s-maxage is how long a change can take there. Read the deploy report before
 * adding such a rule: Cloudflare ignores `Vary` unless the rule says otherwise.
 *
 * Never marked, whatever the switch says:
 *   - a request that names someone: a staff preview, a signed-in shopper or
 *     student, a cart, any Authorization or Cookie;
 *   - a draft store's preview;
 *   - while VISITOR_GATE_ENABLED is on: a kept copy would reach a visitor the
 *     store has blocked, because a blocked visitor is told apart per request;
 *   - anything but a 200, which is left as it was.
 *
 * Off (the default): no header is added or changed.
 */

const PERSONAL_HEADERS = ['authorization', 'cookie', 'x-store-preview', 'x-shopper-token', 'x-student-token', 'x-cart-token', 'x-payment-token', 'x-visitor-id'];

/** The header's value, or null when this request's answer must not be marked. */
function cacheControlFor(req) {
  const settings = env.storefrontPerf.apiCache;
  if (!settings.enabled) return null;
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  if (req.draftPreview || env.visitorGate.enabled) return null;
  if (PERSONAL_HEADERS.some((name) => req.headers[name] !== undefined)) return null;
  return `public, max-age=0, s-maxage=${settings.sMaxage}${settings.swr > 0 ? `, stale-while-revalidate=${settings.swr}` : ''}`;
}

/** Route middleware: sets the header as the response goes out, only on a 200. */
function publicCatalogCache(req, res, next) {
  const value = cacheControlFor(req);
  if (!value) return next();
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 200) {
      res.set('Cache-Control', value);
      res.vary('X-Store-Locale');
    }
    return json(body);
  };
  return next();
}

module.exports = { publicCatalogCache, cacheControlFor, PERSONAL_HEADERS };
