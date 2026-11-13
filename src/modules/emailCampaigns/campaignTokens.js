'use strict';

const crypto = require('crypto');
const env = require('../../config/env');

/**
 * The unsubscribe link of a campaign email names the recipient row it was
 * sent to, signed so it can't be forged to unsubscribe somebody else, and
 * needs no sign-in:
 *
 *   c1.<base64url(workspaceId.recipientId)>.<HMAC-SHA256>
 *
 * The `c1.` prefix keeps it apart from the abandoned-cart email's checkout
 * token (notifications/marketingUnsubscribe.js), which the same storefront
 * page and endpoint read. Its own key, derived from the access-token secret.
 * No expiry: an unsubscribe link has to keep working.
 */

const PREFIX = 'c1.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const key = () => crypto.createHash('sha256').update(`email-campaign-unsubscribe:${env.jwt.accessSecret}`).digest();
const sign = (payload) => crypto.createHmac('sha256', key()).update(payload).digest('base64url');

function tokenFor(workspaceId, recipientId) {
  const payload = `${workspaceId}.${recipientId}`;
  return `${PREFIX}${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

const isCampaignToken = (token) => typeof token === 'string' && token.startsWith(PREFIX);

/** { workspaceId, recipientId } the token names, or null for anything forged, altered or malformed. */
function readToken(token) {
  if (!isCampaignToken(token) || token.length > 500) return null;
  const [encoded, signature, extra] = token.slice(PREFIX.length).split('.');
  if (!encoded || !signature || extra !== undefined) return null;
  const payload = Buffer.from(encoded, 'base64url').toString('utf8');
  const expected = sign(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const [workspaceId, recipientId] = payload.split('.');
  return UUID.test(workspaceId || '') && UUID.test(recipientId || '') ? { workspaceId, recipientId } : null;
}

/** The page a person opens from the email: the store's own unsubscribe page. */
const pageLink = (storeOrigin, token) => (storeOrigin ? `${storeOrigin}/unsubscribe?t=${encodeURIComponent(token)}` : null);

/** The one-click address mail apps POST to (List-Unsubscribe-Post, RFC 8058): this API, no sign-in. */
const oneClickLink = (token) => `${String(env.appUrl).replace(/\/+$/, '')}/api/${env.apiVersion}/email-campaigns/unsubscribe?t=${encodeURIComponent(token)}`;

module.exports = { PREFIX, tokenFor, readToken, isCampaignToken, pageLink, oneClickLink };
