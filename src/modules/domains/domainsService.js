'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../db/models');
const env = require('../../config/env');
const { NotFoundError, ConflictError, AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { lookupTxt } = require('./dnsVerifier');
const rules = require('./domainRules');

/**
 * Merchant custom domains: record one, then verify control of it via a DNS
 * TXT record on _zimos-verify.<host>. TLS is handled by Cloudflare in front
 * of the domain (certificates/), not here.
 *
 * A hostname belongs to a store only once verified: the unique index covers
 * verified and active rows only (migration 211), so an unverified claim never
 * blocks the real owner, and the first store to verify removes the others'
 * pending rows for that host.
 */

const USABLE = ['verified', 'active'];
const { normalizeHostname, txtRecordFor } = rules;

async function addDomain(workspaceId, { hostname }, req) {
  const host = rules.checkHostname(hostname);

  const website = await db.Website.findOne({ where: { workspaceId }, order: [['createdAt', 'ASC']], attributes: ['id'] });
  if (!website) {
    throw new ConflictError('Set up your store (add a product) before connecting a domain', 'STORE_NOT_SET_UP');
  }

  // The store's own pending rows past their 7 days are gone for good.
  await db.Domain.destroy({
    where: { workspaceId, status: 'pending_verification', createdAt: { [Op.lt]: rules.pendingCutoff() } },
  });
  if (await db.Domain.findOne({ where: { workspaceId, hostname: host }, attributes: ['id'] })) {
    throw new ConflictError('That domain is already on this store', 'DOMAIN_ALREADY_ADDED');
  }
  if (await db.Domain.findOne({ where: { hostname: host, status: USABLE }, attributes: ['id'] })) {
    throw new ConflictError('That domain is already connected to a store', 'DOMAIN_TAKEN');
  }
  const max = env.customDomains.maxPerStore;
  if ((await db.Domain.count({ where: { workspaceId } })) >= max) {
    throw new ConflictError(`A store can connect up to ${max} domain${max === 1 ? '' : 's'}: remove one first`, 'DOMAIN_LIMIT_REACHED');
  }

  const domain = await db.Domain.create({
    workspaceId,
    websiteId: website.id,
    hostname: host,
    verificationToken: crypto.randomBytes(16).toString('hex'),
    status: 'pending_verification',
  });

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'domain.add',
    entityType: 'Domain',
    entityId: domain.id,
    after: { hostname: host },
    req,
  });

  return { domain, record: txtRecordFor(domain) };
}

async function listDomains(workspaceId) {
  const domains = await db.Domain.findAll({ where: { workspaceId }, order: [['createdAt', 'ASC']] });
  return domains.map((d) => ({
    id: d.id,
    hostname: d.hostname,
    status: d.status,
    verifiedAt: d.verifiedAt,
    record: txtRecordFor(d),
    cname: { type: 'CNAME', name: d.hostname, value: rules.cnameTarget() },
  }));
}

async function verifyDomain(workspaceId, domainId, req) {
  const domain = await db.Domain.findOne({ where: { id: domainId, workspaceId } });
  if (!domain) throw new NotFoundError('Domain');
  if (USABLE.includes(domain.status)) {
    return { domain, verified: true };
  }
  if (rules.isExpiredPending(domain)) {
    throw new ConflictError('This domain was not verified within 7 days: remove it and add it again', 'DOMAIN_VERIFICATION_EXPIRED');
  }

  const expected = rules.verificationValue(domain);
  const recordName = rules.verificationName(domain.hostname);
  let records = [];
  try {
    records = await lookupTxt(recordName);
  } catch (err) {
    records = []; // NXDOMAIN / no TXT records — treated as "not found yet"
  }
  const found = (records || []).some((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks)) === expected);

  if (!found) {
    throw new AppError(
      'DOMAIN_NOT_VERIFIED',
      `No TXT record "${expected}" found on ${recordName} yet — add it at your DNS provider and try again`,
      400
    );
  }

  try {
    await db.sequelize.transaction(async (transaction) => {
      await domain.update({ status: 'verified', verifiedAt: new Date() }, { transaction });
      // The host is this store's now: other stores' unverified claims go.
      await db.Domain.destroy({
        where: { hostname: domain.hostname, id: { [Op.ne]: domain.id }, status: 'pending_verification' },
        transaction,
      });
    });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      throw new ConflictError('That domain is already connected to a store', 'DOMAIN_TAKEN');
    }
    throw err;
  }
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'domain.verify',
    entityType: 'Domain',
    entityId: domain.id,
    after: { hostname: domain.hostname, status: 'verified' },
    req,
  });
  // The provider hears of the hostname only now that our TXT proved control.
  await require('./domainSettings').requestAfterVerify(domain);

  return { domain, verified: true };
}

/**
 * Removing a custom domain is a genuine hard delete: a Domain row only drives
 * host -> workspace routing (see hostResolver). Nothing in order or financial
 * history references it, so there's nothing to preserve by archiving.
 */
async function deleteDomain(workspaceId, domainId, req) {
  const domain = await db.Domain.findOne({ where: { id: domainId, workspaceId } });
  if (!domain) throw new NotFoundError('Domain');
  const before = domain.toJSON();
  // The delete queues the provider's hostname in the same transaction
  // (migration 214); removing it at the provider now clears that row.
  await domain.destroy();
  await require('./domainSettings').revokeCertificate(domain);
  // It may have been the store's canonical address (primaryHost.js), and its
  // pages may be kept at the edge under it (storefront/cloudflarePurge.js).
  require('./primaryHost').forget(workspaceId);
  require('../storefront/storefrontCache').invalidate(workspaceId, {
    previousHosts: USABLE.includes(before.status) ? [before.hostname] : [],
  });

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'domain.delete',
    entityType: 'Domain',
    entityId: domainId,
    before,
    req,
  });

  return { deleted: true, id: domainId };
}

module.exports = { addDomain, listDomains, verifyDomain, deleteDomain, normalizeHostname };
