'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const entitlements = require('../billing/entitlementsService');
const { getCertificateProvider, certificateProviderConfigured } = require('./certificates');
const { refreshCertificate } = require('./domainSettings');
const { pendingCutoff } = require('./domainRules');

/**
 * The scheduled work behind custom domains (jobs.js). Each run takes a
 * bounded batch, and one domain's failure never stops the others.
 *
 * While CUSTOM_DOMAINS_ENABLED is off, everything but the provider deletion
 * retry does nothing, as before these jobs existed. The certificate jobs and
 * the reconciliation need a provider (CERTIFICATE_PROVIDER) too.
 */

const BATCH = 100;
const CERTIFICATE_DEADLINE_MS = 72 * 60 * 60 * 1000;
const USABLE = ['verified', 'active'];
const enabled = () => env.customDomains.enabled === true;

// The store's canonical host may have changed: its subdomain may now send
// shoppers on to the domain, or stop. invalidate() drops its pages at the edge too.
function forgetStore(workspaceId) {
  require('./primaryHost').forget(workspaceId);
  require('../storefront/storefrontCache').invalidate(workspaceId);
}

async function each(rows, fn) {
  let failed = 0;
  for (const row of rows) {
    try {
      await fn(row);
    } catch (err) {
      failed += 1;
      logger.warn('domains job: one domain failed', { domainId: row.id, error: err.message });
    }
  }
  return { checked: rows.length, failed };
}

/**
 * Every 5 minutes: verified domains with no certificate yet. A first request
 * that failed is made again; a pending one is asked where it stands; still
 * not issued 72 hours after the request, it is failed with a reason the
 * merchant can act on.
 */
async function pollPendingCertificates(now = Date.now()) {
  if (!enabled() || !certificateProviderConfigured()) return { checked: 0, failed: 0 };
  const rows = await db.Domain.findAll({
    where: { status: USABLE, sslStatus: ['none', 'pending'], suspendedAt: null },
    order: [['sslCheckedAt', 'ASC NULLS FIRST']],
    limit: BATCH,
  });
  return each(rows, async (domain) => {
    // The 72 hours count from the provider request (migration 630), not from the
    // verification: a domain verified before a provider was set up gets its full time.
    // A first request the provider kept refusing ('none', its attempts recorded by
    // refreshCertificate) runs out the same way, with the provider's last answer.
    const since = domain.sslRequestedAt ? new Date(domain.sslRequestedAt).getTime() : null;
    const was = `${domain.status}/${domain.sslStatus}`;
    if (since !== null && now - since > CERTIFICATE_DEADLINE_MS) {
      const neverRequested = domain.sslStatus === 'none' && domain.sslDetail;
      await domain.update({
        sslStatus: 'failed',
        sslCheckedAt: new Date(now),
        sslDetail: neverRequested
          ? `The certificate could not be requested within 72 hours: ${domain.sslDetail}`.slice(0, 300)
          : 'The certificate was not issued within 72 hours: check that the CNAME record points at us',
      });
    } else {
      await refreshCertificate(domain);
    }
    // Only a domain whose state moved changes how the store is served: a
    // still-pending one, asked every 5 minutes, leaves the store's caches be
    // (its pages at Cloudflare included).
    if (`${domain.status}/${domain.sslStatus}` !== was) forgetStore(domain.workspaceId);
  });
}

/** Daily: issued domains, to notice one the merchant pointed elsewhere (moved). */
async function checkActiveCertificates() {
  if (!enabled() || !certificateProviderConfigured()) return { checked: 0, failed: 0 };
  const rows = await db.Domain.findAll({
    where: { status: 'active', sslStatus: 'issued', sslProviderRef: { [Op.ne]: null } },
    order: [['sslCheckedAt', 'ASC NULLS FIRST']],
    limit: BATCH * 5,
  });
  return each(rows, async (domain) => {
    await refreshCertificate(domain);
    if (domain.sslStatus !== 'issued') forgetStore(domain.workspaceId);
  });
}

/**
 * Every 15 minutes: hostnames still to remove at the provider. Done (or 404
 * at the provider) removes the row; a failure waits longer each time, up to
 * 6 hours.
 */
async function retryProviderDeletions(now = Date.now()) {
  if (!certificateProviderConfigured()) return { checked: 0, failed: 0 };
  const rows = await db.DomainProviderDeletion.findAll({
    where: { nextAttemptAt: { [Op.lte]: new Date(now) } },
    order: [['nextAttemptAt', 'ASC']],
    limit: BATCH,
  });
  const provider = getCertificateProvider();
  let failed = 0;
  for (const row of rows) {
    if (row.provider !== provider.code) continue;
    // A domain row holds this hostname again (asked for anew, the provider
    // answered with the same one): removing it would take that domain down.
    if (await db.Domain.count({ where: { sslProviderRef: row.providerRef } })) {
      logger.warn('domains: queued provider deletion dropped, a domain uses it', { hostname: row.hostname });
      await row.destroy();
      continue;
    }
    try {
      await provider.revoke({ hostname: row.hostname, providerRef: row.providerRef });
      await row.destroy();
    } catch (err) {
      failed += 1;
      const attempts = row.attempts + 1;
      const waitMs = Math.min(attempts * 15 * 60 * 1000, 6 * 60 * 60 * 1000);
      await row.update({ attempts, lastError: String(err.message || 'unknown error').slice(0, 500), nextAttemptAt: new Date(now + waitMs) });
    }
  }
  return { checked: rows.length, failed };
}

const RECONCILE_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Daily: custom hostnames at Cloudflare that no domain row knows (a row that
 * went before migration 214's trigger, an answer lost before its ref was
 * saved) are queued for the deletion retry above. Only with
 * CUSTOM_DOMAINS_ENABLED and CERTIFICATE_PROVIDER=cloudflare. Never touched:
 * a hostname a domain row knows by ref or by name, whatever its status; one
 * made in the last hour or with no creation time (its row may not have its
 * ref yet); one already queued. More than CUSTOM_DOMAINS_RECONCILE_MAX in
 * one run queues none and warns: that many is likelier a fault than a leak.
 */
async function reconcileProviderHostnames(now = Date.now()) {
  const idle = { listed: 0, orphans: 0, queued: 0, capped: false };
  if (!enabled() || !certificateProviderConfigured()) return idle;
  const provider = getCertificateProvider();
  if (provider.code !== 'cloudflare' || typeof provider.listHostnames !== 'function') return idle;

  const listed = await provider.listHostnames();
  if (!listed.length) return idle;
  const known = await db.Domain.findAll({
    where: {
      [Op.or]: [{ sslProviderRef: listed.map((h) => h.providerRef) }, { hostname: listed.map((h) => h.hostname) }],
    },
    attributes: ['hostname', 'sslProviderRef'],
  });
  const knownRefs = new Set(known.map((d) => d.sslProviderRef).filter(Boolean));
  const knownHosts = new Set(known.map((d) => String(d.hostname).toLowerCase()));
  const oldEnough = (h) => {
    const created = Date.parse(h.createdAt || '');
    return Number.isFinite(created) && now - created >= RECONCILE_MIN_AGE_MS;
  };
  const candidates = listed.filter((h) => !knownRefs.has(h.providerRef) && !knownHosts.has(h.hostname) && oldEnough(h));
  const queuedAlready = candidates.length
    ? await db.DomainProviderDeletion.findAll({
        where: { provider: provider.code, providerRef: candidates.map((h) => h.providerRef) },
        attributes: ['providerRef'],
      })
    : [];
  const queuedRefs = new Set(queuedAlready.map((r) => r.providerRef));
  const orphans = candidates.filter((h) => !queuedRefs.has(h.providerRef));
  const result = { listed: listed.length, orphans: orphans.length, queued: 0, capped: false };
  if (!orphans.length) return result;

  const max = env.customDomains.reconcileMax;
  if (orphans.length > max) {
    logger.warn('domains reconcile: more orphan hostnames than CUSTOM_DOMAINS_RECONCILE_MAX; none queued', {
      orphans: orphans.length,
      max,
    });
    return { ...result, capped: true };
  }
  await db.DomainProviderDeletion.bulkCreate(
    orphans.map((h) => ({
      workspaceId: null,
      hostname: h.hostname,
      provider: provider.code,
      providerRef: h.providerRef,
      attempts: 0,
      nextAttemptAt: new Date(now),
    })),
    { ignoreDuplicates: true }
  );
  logger.warn('domains reconcile: orphan hostnames queued for deletion', { hostnames: orphans.map((h) => h.hostname) });
  return { ...result, queued: orphans.length };
}

/** Hourly: pending rows past their 7 days (never verified, never at the provider). */
async function removeExpiredPending(now = Date.now()) {
  if (!enabled()) return { removed: 0 };
  const removed = await db.Domain.destroy({
    where: { status: 'pending_verification', createdAt: { [Op.lt]: pendingCutoff(now) } },
  });
  return { removed };
}

/** Why a store's domains should not be served now, or null. */
async function suspensionReason(workspace) {
  if (!workspace || workspace.status === 'suspended') return 'store_suspended';
  if (env.planFeatures.enforcement && !(await entitlements.hasFeature(workspace.id, 'custom_domain'))) return 'plan';
  return null;
}

/**
 * Every 10 minutes: a verified domain of a suspended store, or of a store
 * whose plan lost custom_domain (PLAN_FEATURE_ENFORCEMENT on), stops being
 * served; it is suspended, never deleted, and served again once the reason
 * is gone.
 */
async function enforceAccess(now = Date.now()) {
  if (!enabled()) return { suspended: 0, restored: 0 };
  const domains = await db.Domain.findAll({ where: { status: USABLE }, attributes: ['id', 'workspaceId', 'suspendedAt', 'suspendedReason'] });
  const storeIds = [...new Set(domains.map((d) => d.workspaceId))];
  const stores = await db.Workspace.findAll({ where: { id: storeIds }, attributes: ['id', 'status'] });
  const byId = new Map(stores.map((w) => [w.id, w]));
  const reasons = new Map();
  for (const id of storeIds) reasons.set(id, await suspensionReason(byId.get(id)));

  let suspended = 0;
  let restored = 0;
  for (const domain of domains) {
    const reason = reasons.get(domain.workspaceId);
    if (reason && domain.suspendedReason !== reason) {
      await domain.update({ suspendedAt: domain.suspendedAt || new Date(now), suspendedReason: reason });
      suspended += 1;
      forgetStore(domain.workspaceId);
    } else if (!reason && domain.suspendedAt) {
      await domain.update({ suspendedAt: null, suspendedReason: null });
      restored += 1;
      forgetStore(domain.workspaceId);
    }
  }
  return { suspended, restored };
}

module.exports = {
  CERTIFICATE_DEADLINE_MS,
  pollPendingCertificates,
  checkActiveCertificates,
  retryProviderDeletions,
  reconcileProviderHostnames,
  removeExpiredPending,
  enforceAccess,
};
