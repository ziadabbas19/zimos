'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { AppError, ConflictError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { PLATFORM_ROLES } = require('../../core/security/platformPermissions');
const terms = require('./referralTerms');
const { v2Enabled } = require('./referralPricing');

/**
 * Which agent earns on a store's payments (agent_links, migration 725).
 *
 * One open link per store at a time (a unique index). A link comes from:
 *   - a code: entering a code with an agent links the store to that agent
 *     when the code says so (links_agent) and the store has no open link
 *     yet. An existing link is never replaced by a code: the agent who
 *     brought the store first keeps it, whichever way they did;
 *   - the console (source 'manual', REFERRAL_CODES_V2_ENABLED): any store to
 *     any agent, from a start date, at a rate or a schedule, until an
 *     optional end date. Setting one while another is open ends the open one
 *     ('replaced'): that is how the console moves a store to another agent.
 *
 * A link earns on every payment from its start (commissionService). Editing
 * one changes the payments to come only: rows already written keep their
 * rate. Every change is audited (who, when, before and after); a link is
 * never deleted, so the rows are the history.
 */

const LINK_INCLUDE = [
  { model: db.User, as: 'agent', attributes: ['id', 'fullName', 'email'] },
  { model: db.ReferralCode, as: 'code', attributes: ['id', 'code'] },
  { model: db.User, as: 'createdBy', attributes: ['id', 'fullName'] },
  { model: db.User, as: 'endedBy', attributes: ['id', 'fullName'] },
];

function serializeLink(link) {
  return {
    id: link.id,
    workspaceId: link.workspaceId,
    agent: link.agent ? { id: link.agent.id, fullName: link.agent.fullName, email: link.agent.email } : { id: link.agentId },
    source: link.source,
    code: link.code ? { id: link.code.id, code: link.code.code } : link.codeId ? { id: link.codeId } : null,
    redemptionId: link.redemptionId,
    legacy: link.legacy,
    startsAt: link.startsAt,
    endsAt: link.endsAt,
    endedAt: link.endedAt,
    endReason: link.endReason,
    open: link.endedAt == null,
    terms: link.terms,
    commissionBasis: link.commissionBasis,
    note: link.note,
    createdBy: link.createdBy ? { id: link.createdBy.id, fullName: link.createdBy.fullName } : null,
    endedBy: link.endedBy ? { id: link.endedBy.id, fullName: link.endedBy.fullName } : null,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}

function auditState(link) {
  return {
    agentId: link.agentId,
    source: link.source,
    codeId: link.codeId,
    startsAt: link.startsAt,
    endsAt: link.endsAt,
    endedAt: link.endedAt,
    endReason: link.endReason,
    terms: link.terms,
    commissionBasis: link.commissionBasis,
    note: link.note,
  };
}

async function audit(action, req, link, before, after, transaction, metadata = {}) {
  await recordAudit({
    actorUserId: req.user.id,
    action,
    entityType: 'AgentLink',
    entityId: link.id,
    before,
    after,
    metadata: { workspaceId: link.workspaceId, agentId: link.agentId, ...metadata },
    req,
    transaction,
  });
}

const openLink = (workspaceId, transaction, lock = false) =>
  db.AgentLink.findOne({ where: { workspaceId, endedAt: null }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });

/**
 * The link a payment made at `at` earns for: started by then, not ended or
 * past its end date by then.
 */
function linkAt(workspaceId, at, transaction) {
  return db.AgentLink.findOne({
    where: {
      workspaceId,
      startsAt: { [Op.lte]: at },
      [Op.and]: [
        { [Op.or]: [{ endsAt: null }, { endsAt: { [Op.gt]: at } }] },
        { [Op.or]: [{ endedAt: null }, { endedAt: { [Op.gt]: at } }] },
      ],
    },
    order: [['startsAt', 'DESC'], ['createdAt', 'DESC']],
    transaction,
  });
}

/** A code's commission schedule per cycle, as a link carries it. */
function linkTermsOf(code) {
  if (!code.terms) return null;
  return { monthly: terms.forCycle(code.terms, 'monthly').commission, yearly: terms.forCycle(code.terms, 'yearly').commission };
}

/**
 * Entering `code` (redemptionService, in its transaction): links the store
 * to the code's agent when the code says so and the store has no open link.
 * A code of the first kind makes a link of the old kind (legacy: it earns on
 * the payments that carry the code, at the code's rate).
 */
async function linkFromCode(workspaceId, code, redemption, transaction, now = new Date()) {
  if (!code.agentId || code.linksAgent === false) return null;
  if (await openLink(workspaceId, transaction, true)) return null;
  return db.AgentLink.create(
    {
      workspaceId,
      agentId: code.agentId,
      source: 'code',
      codeId: code.id,
      redemptionId: redemption.id,
      legacy: !code.terms,
      startsAt: now,
      terms: linkTermsOf(code),
      commissionBasis: code.commissionBasis || 'paid',
    },
    { transaction }
  );
}

function assertV2() {
  if (!v2Enabled()) {
    throw new AppError('REFERRAL_V2_DISABLED', 'Linking a store to an agent by hand is not switched on.', 409);
  }
}

async function assertAgent(agentId, transaction) {
  const agent = await db.User.findByPk(agentId, { attributes: ['id', 'platformRole'], transaction });
  if (!agent) throw new NotFoundError('Agent');
  if (agent.platformRole !== PLATFORM_ROLES.AGENT) {
    throw new ConflictError('A store can only be linked to an account with the agent role.', 'NOT_AN_AGENT');
  }
}

function checkedTerms(body) {
  const errors = terms.validateLinkTerms(body.terms);
  if (errors.length) throw new ValidationError(errors, 'Invalid body');
  return terms.normalizeLinkTerms(body.terms);
}

function checkDates(startsAt, endsAt) {
  if (endsAt && new Date(endsAt) <= new Date(startsAt)) {
    throw new ValidationError([{ field: 'endsAt', message: 'The end date must be after the start date' }], 'Invalid body');
  }
}

/** GET /admin/workspaces/:id/agent-links — every link of the store, newest first. */
async function listForWorkspace(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id'] });
  if (!workspace) throw new NotFoundError('Workspace');
  const links = await db.AgentLink.findAll({ where: { workspaceId }, include: LINK_INCLUDE, order: [['createdAt', 'DESC'], ['id', 'ASC']] });
  return links.map(serializeLink);
}

/**
 * POST /admin/workspaces/:id/agent-links — links the store to `agentId` by
 * hand. The open link, if any, ends now ('replaced').
 */
async function createManual(workspaceId, body, req) {
  assertV2();
  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id'], transaction, lock: transaction.LOCK.UPDATE });
    if (!workspace) throw new NotFoundError('Workspace');
    await assertAgent(body.agentId, transaction);
    const now = new Date();
    const startsAt = body.startsAt ? new Date(body.startsAt) : now;
    checkDates(startsAt, body.endsAt);
    const schedule = checkedTerms(body);

    const open = await openLink(workspaceId, transaction, true);
    let replaced = null;
    if (open) {
      const before = auditState(open);
      await open.update({ endedAt: now, endReason: 'replaced', endedByUserId: req.user.id }, { transaction });
      await audit('agent_link.end', req, open, before, auditState(open), transaction, { reason: 'replaced' });
      replaced = open.id;
    }
    const link = await db.AgentLink.create(
      {
        workspaceId,
        agentId: body.agentId,
        source: 'manual',
        startsAt,
        endsAt: body.endsAt ? new Date(body.endsAt) : null,
        terms: schedule,
        commissionBasis: body.commissionBasis || 'paid',
        note: body.note || null,
        createdByUserId: req.user.id,
      },
      { transaction }
    );
    await audit('agent_link.create', req, link, null, auditState(link), transaction, { replacedLinkId: replaced });
    await link.reload({ include: LINK_INCLUDE, transaction });
    return serializeLink(link);
  });
}

/** PATCH /admin/agent-links/:id — an open link's end date, schedule, basis or note; for the payments to come. */
async function update(linkId, patch, req) {
  assertV2();
  return db.sequelize.transaction(async (transaction) => {
    const link = await db.AgentLink.findByPk(linkId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!link) throw new NotFoundError('Agent link');
    if (link.endedAt) throw new ConflictError('This link has ended. Link the store again instead.', 'AGENT_LINK_ENDED');
    const next = {};
    if ('endsAt' in patch) next.endsAt = patch.endsAt ? new Date(patch.endsAt) : null;
    if ('terms' in patch) next.terms = checkedTerms(patch);
    if ('commissionBasis' in patch) next.commissionBasis = patch.commissionBasis;
    if ('note' in patch) next.note = patch.note || null;
    // A link of the old kind takes a schedule only by becoming a new-kind one.
    if (next.terms) next.legacy = false;
    checkDates(link.startsAt, 'endsAt' in next ? next.endsAt : link.endsAt);
    const before = auditState(link);
    await link.update(next, { transaction });
    await audit('agent_link.update', req, link, before, auditState(link), transaction);
    await link.reload({ include: LINK_INCLUDE, transaction });
    return serializeLink(link);
  });
}

/** POST /admin/agent-links/:id/end — ends an open link now. Ending one is allowed with the flag off. */
async function end(linkId, { note }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const link = await db.AgentLink.findByPk(linkId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!link) throw new NotFoundError('Agent link');
    if (link.endedAt) throw new ConflictError('This link has already ended.', 'AGENT_LINK_ENDED');
    const before = auditState(link);
    await link.update({ endedAt: new Date(), endReason: 'ended', endedByUserId: req.user.id, ...(note ? { note } : {}) }, { transaction });
    await audit('agent_link.end', req, link, before, auditState(link), transaction, { reason: 'ended' });
    await link.reload({ include: LINK_INCLUDE, transaction });
    return serializeLink(link);
  });
}

module.exports = { serializeLink, openLink, linkAt, linkFromCode, linkTermsOf, listForWorkspace, createManual, update, end, LINK_INCLUDE };
