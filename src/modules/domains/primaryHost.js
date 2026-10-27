'use strict';

const db = require('../../db/models');
const env = require('../../config/env');

/**
 * The store's canonical address (SPEC §8.11): its primary domain when it has
 * one that can be served — verified, and with a certificate issued — else its
 * platform subdomain. Everything that hands out a link to the store uses it:
 * the storefront's canonical / sitemap / robots (GET /store/:ws → primaryHost),
 * the product feed, the links in messages, and the storefront proxy's
 * redirect from the other hosts (GET /store/resolve-host → primaryHost).
 *
 * A primary domain without a certificate is not used: an https link to it
 * would not open. Remembered for a minute per process; changing the primary
 * domain or its certificate clears the entry (domainSettings.js).
 */

const USABLE = ['verified', 'active'];
const TTL_MS = 60 * 1000;
const cache = new Map();

async function primaryHostOf(workspaceId) {
  if (!workspaceId) return null;
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const domain = await db.Domain.findOne({
    where: { workspaceId, isPrimary: true, status: USABLE, sslStatus: 'issued', suspendedAt: null },
    attributes: ['hostname'],
  });
  const value = domain ? domain.hostname : null;
  if (cache.size > 5000) cache.clear();
  cache.set(workspaceId, { at: Date.now(), value });
  return value;
}

function forget(workspaceId) {
  if (workspaceId) cache.delete(workspaceId);
  else cache.clear();
}

const platformOrigin = (workspace) => (workspace && workspace.slug ? `https://${workspace.slug}.${env.platformRootDomain}` : '');

/** `https://<primary domain>`, else `https://<slug>.<platform domain>`; '' without a workspace. */
async function storeOriginOf(workspace) {
  if (!workspace) return '';
  const primary = await primaryHostOf(workspace.id).catch(() => null);
  return primary ? `https://${primary}` : platformOrigin(workspace);
}

/**
 * storeOriginOf for many stores at once (the console's lists): one query for
 * all their primary domains, the same rule, no cache. A Map of workspace id
 * to origin; '' for a store without a slug.
 */
async function storeOriginsOf(workspaces) {
  const list = (workspaces || []).filter(Boolean);
  const ids = [...new Set(list.map((w) => w.id))];
  const domains = ids.length
    ? await db.Domain.findAll({
        where: { workspaceId: ids, isPrimary: true, status: USABLE, sslStatus: 'issued', suspendedAt: null },
        attributes: ['workspaceId', 'hostname'],
      })
    : [];
  const primary = new Map(domains.map((d) => [d.workspaceId, d.hostname]));
  return new Map(list.map((w) => [w.id, primary.has(w.id) ? `https://${primary.get(w.id)}` : platformOrigin(w)]));
}

/** `<slug>` when `host` is a store's platform subdomain (`<slug>.<platform domain>`), else null. */
function platformSlugOf(host) {
  const root = String(env.platformRootDomain || '').toLowerCase();
  const h = String(host || '').toLowerCase();
  if (!root || !h.endsWith(`.${root}`)) return null;
  const slug = h.slice(0, -(root.length + 1));
  return slug && !slug.includes('.') ? slug : null;
}

module.exports = { primaryHostOf, storeOriginOf, storeOriginsOf, platformOrigin, platformSlugOf, forget };
