'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const env = require('../../config/env');
const { NotFoundError, ConflictError, ValidationError, AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { lookupTxt } = require('./dnsVerifier');

/**
 * Merchant custom domains: record one, then verify control of it via a DNS
 * TXT record. TLS is handled by Cloudflare in front of the domain, not here.
 */

const TXT_PREFIX = 'zimos-verify=';

function normalizeHostname(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '');
}

function txtRecordFor(domain) {
  return { type: 'TXT', name: domain.hostname, value: TXT_PREFIX + domain.verificationToken };
}

async function addDomain(workspaceId, { hostname }, req) {
  const host = normalizeHostname(hostname);
  if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
    throw new ValidationError([{ field: 'hostname', message: 'Enter a valid domain like ahmedstore.com' }]);
  }
  if (env.platformRootDomain && host.endsWith('.' + env.platformRootDomain)) {
    throw new ValidationError(
      [{ field: 'hostname', message: `That is a ${env.platformRootDomain} subdomain — it already works, no setup needed` }]
    );
  }

  const website = await db.Website.findOne({ where: { workspaceId }, order: [['createdAt', 'ASC']], attributes: ['id'] });
  if (!website) {
    throw new ConflictError('Set up your store (add a product) before connecting a domain', 'STORE_NOT_SET_UP');
  }

  let domain;
  try {
    domain = await db.Domain.create({
      workspaceId,
      websiteId: website.id,
      hostname: host,
      verificationToken: crypto.randomBytes(16).toString('hex'),
      status: 'pending_verification',
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
  }));
}

async function verifyDomain(workspaceId, domainId, req) {
  const domain = await db.Domain.findOne({ where: { id: domainId, workspaceId } });
  if (!domain) throw new NotFoundError('Domain');
  if (domain.status === 'verified' || domain.status === 'active') {
    return { domain, verified: true };
  }

  const expected = TXT_PREFIX + domain.verificationToken;
  let records = [];
  try {
    records = await lookupTxt(domain.hostname);
  } catch (err) {
    records = []; // NXDOMAIN / no TXT records — treated as "not found yet"
  }
  const found = (records || []).some((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks)) === expected);

  if (!found) {
    throw new AppError(
      'DOMAIN_NOT_VERIFIED',
      `No TXT record "${expected}" found on ${domain.hostname} yet — add it at your DNS provider and try again`,
      400
    );
  }

  await domain.update({ status: 'verified', verifiedAt: new Date() });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'domain.verify',
    entityType: 'Domain',
    entityId: domain.id,
    after: { hostname: domain.hostname, status: 'verified' },
    req,
  });

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
  await domain.destroy();

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
