'use strict';

/**
 * A store's own domains as the console's store list shows them
 * (GET /admin/workspaces): the one to show beside the platform subdomain, and
 * whether it is connected. The rule for "connected" is primaryHost.js's: the
 * domain is verified, its certificate issued, and it is not suspended.
 *
 * The state is worked out here, not in the database, so the functions above
 * the query need no connection (tests/unit/storeDomains.test.js).
 */

const USABLE = ['verified', 'active'];
const PROBLEM_SSL = ['failed', 'moved'];
const STATE_ORDER = { connected: 0, pending: 1, problem: 2 };

/**
 * connected: served on https. problem: verification failed, the certificate
 * failed or the domain no longer points at the store (ssl "moved"), or it is
 * suspended (store suspended, plan without custom_domain). pending: anything
 * else — DNS not verified yet, or the certificate not issued yet.
 */
function domainState(domain) {
  if (domain.suspendedAt || domain.status === 'failed' || PROBLEM_SSL.includes(domain.sslStatus)) return 'problem';
  if (USABLE.includes(domain.status) && domain.sslStatus === 'issued') return 'connected';
  return 'pending';
}

/** What the console is told about one domain: never its verification token or provider reference. */
function summarize(domain) {
  return {
    hostname: domain.hostname,
    status: domain.status,
    sslStatus: domain.sslStatus,
    primary: Boolean(domain.isPrimary),
    suspended: Boolean(domain.suspendedAt),
    state: domainState(domain),
  };
}

const createdAtOf = (domain) => new Date(domain.createdAt || 0).getTime();

/** The domain a store is shown with: its primary one, else the healthiest, else the newest. */
function shownDomain(domains) {
  const sorted = [...domains].sort(
    (a, b) =>
      Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)) ||
      STATE_ORDER[domainState(a)] - STATE_ORDER[domainState(b)] ||
      createdAtOf(b) - createdAtOf(a)
  );
  return sorted[0] || null;
}

/** Domain rows of many stores → Map of workspace id to { domain: summary, count }. */
function byStore(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    if (!groups.has(row.workspaceId)) groups.set(row.workspaceId, []);
    groups.get(row.workspaceId).push(row);
  }
  const out = new Map();
  for (const [workspaceId, domains] of groups) {
    out.set(workspaceId, { domain: summarize(shownDomain(domains)), count: domains.length });
  }
  return out;
}

/** byStore for these stores, every domain in one query. */
async function customDomainsOf(workspaceIds) {
  const ids = [...new Set((workspaceIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  const db = require('../../db/models');
  const rows = await db.Domain.findAll({
    where: { workspaceId: ids },
    attributes: ['workspaceId', 'hostname', 'status', 'sslStatus', 'isPrimary', 'suspendedAt', 'createdAt'],
  });
  return byStore(rows);
}

module.exports = { domainState, summarize, shownDomain, byStore, customDomainsOf };
