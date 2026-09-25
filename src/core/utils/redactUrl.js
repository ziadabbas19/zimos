'use strict';

/**
 * A request URL safe to log: gateway signatures in the query string and the
 * per-merchant webhook tokens in callback paths are replaced with
 * "[redacted]". Anyone holding a callback URL's token and a valid signature
 * could replay it, so neither belongs in a log.
 */

const SECRET_PARAMS = new Set(['hmac', 'signature', 'sig', 'x-signature', 'token', 'secret']);
const WEBHOOK_PATH = /(\/webhooks\/(?:payments|carriers)\/[^/?#]+\/)[^/?#]+/i;

function redactUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  const [pathAndQuery, hash = ''] = url.split('#');
  const q = pathAndQuery.indexOf('?');
  let path = q === -1 ? pathAndQuery : pathAndQuery.slice(0, q);
  let query = q === -1 ? '' : pathAndQuery.slice(q + 1);

  path = path.replace(WEBHOOK_PATH, '$1[redacted]');
  if (query) {
    query = query
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        const key = eq === -1 ? pair : pair.slice(0, eq);
        let name = key;
        try {
          name = decodeURIComponent(key);
        } catch (err) {
          name = key;
        }
        return SECRET_PARAMS.has(name.toLowerCase()) ? `${key}=[redacted]` : pair;
      })
      .join('&');
  }
  return `${path}${query ? `?${query}` : ''}${hash ? `#${hash}` : ''}`;
}

module.exports = { redactUrl };
