'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { AppError, ConflictError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { PLATFORM_ROLES, isCreator } = require('../../core/security/platformPermissions');
const terms = require('./referralTerms');
const { v2Enabled } = require('./referralPricing');
const reviewNotifications = require('./referralReviewNotifications');

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
 *
 * Only a creator's change applies at once. Anyone else's (linking, moving,
 * changing or ending) becomes a request (agent_link_requests, migration 743),
 * which a creator or someone else holding referral_codes.approve approves or
 * rejects: until then nothing changes in agent_links, so the link as it stands
 * goes on earning. One waiting per store. Links a code makes when a store
 * enters it aren't requests: the code itself has been reviewed.
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

const REQUEST_INCLUDE = [
  { model: db.Workspace, as: 'workspace', attributes: ['id', 'name'] },
  { model: db.AgentLink, as: 'link', attributes: ['id', 'agentId', 'createdByUserId'] },
  { model: db.User, as: 'requestedBy', attributes: ['id', 'fullName'] },
  { model: db.User, as: 'reviewedBy', attributes: ['id', 'fullName'] },
];

const person = (user) => (user ? { id: user.id, fullName: user.fullName } : null);

/** Who may not review it, a creator aside: whoever asked for it, or made the link it changes. */
const authorsOf = (request) => [...new Set([request.requestedByUserId, request.link ? request.link.createdByUserId : null])].filter(Boolean);

/** `agents`: the people it names, by id (withAgents). */
function serializeRequest(request, agents = new Map()) {
  const agentId = request.changes.agentId || (request.link ? request.link.agentId : null);
  const agent = agents.get(agentId);
  return {
    id: request.id,
    workspaceId: request.workspaceId,
    workspace: request.workspace ? { id: request.workspace.id, name: request.workspace.name } : { id: request.workspaceId },
    linkId: request.agentLinkId,
    kind: request.kind,
    changes: request.changes,
    agent: agentId ? { id: agentId, ...(agent ? { fullName: agent.fullName, email: agent.email } : {}) } : null,
    status: request.status,
    reason: request.reason,
    requestedBy: person(request.requestedBy),
    reviewedBy: person(request.reviewedBy),
    reviewedAt: request.reviewedAt,
    authorIds: authorsOf(request),
    createdAt: request.createdAt,
  };
}

async function withAgents(requests) {
  const ids = [...new Set(requests.map((r) => r.changes.agentId || (r.link && r.link.agentId)).filter(Boolean))];
  const agents = ids.length ? await db.User.findAll({ where: { id: ids }, attributes: ['id', 'fullName', 'email'] }) : [];
  const byId = new Map(agents.map((a) => [a.id, a]));
  return requests.map((r) => serializeRequest(r, byId));
}

async function auditRequest(action, req, request, before, transaction) {
  await recordAudit({
    actorUserId: req.user.id,
    action,
    entityType: 'AgentLinkRequest',
    entityId: request.id,
    before,
    after: { status: request.status, kind: request.kind, changes: request.changes, reason: request.reason },
    metadata: { workspaceId: request.workspaceId, agentLinkId: request.agentLinkId },
    req,
    transaction,
  });
}

/** A change from anyone but a creator: asked for, checked, and nothing else yet. */
async function askFor(kind, workspaceId, agentLinkId, changes, req, transaction) {
  const waiting = await db.AgentLinkRequest.findOne({ where: { workspaceId, status: 'pending' }, attributes: ['id'], transaction });
  if (waiting) throw new ConflictError("A change to this store's agent is already waiting for review.", 'AGENT_LINK_REQUEST_PENDING');
  let request;
  try {
    request = await db.AgentLinkRequest.create({ workspaceId, agentLinkId, kind, changes, requestedByUserId: req.user.id }, { transaction });
  } catch (err) {
    // Two at once both pass the check above; the index catches the loser.
    if (err && err.name === 'SequelizeUniqueConstraintError') {
      throw new ConflictError("A change to this store's agent is already waiting for review.", 'AGENT_LINK_REQUEST_PENDING');
    }
    throw err;
  }
  await auditRequest('agent_link.request', req, request, null, transaction);
  await request.reload({ include: REQUEST_INCLUDE, transaction });
  const [serialized] = await withAgents([request]);
  await reviewNotifications.linkWaiting(serialized, req, transaction);
  return { request: serialized };
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

/** The checked fields of a new link; `startsAt` stays empty when none was asked for, so it means "now" whenever it applies. */
async function linkFields(body, transaction) {
  await assertAgent(body.agentId, transaction);
  checkDates(body.startsAt ? new Date(body.startsAt) : new Date(), body.endsAt);
  return {
    agentId: body.agentId,
    startsAt: body.startsAt || null,
    endsAt: body.endsAt || null,
    terms: checkedTerms(body),
    commissionBasis: body.commissionBasis || 'paid',
    note: body.note || null,
  };
}

/** Links the store now. The open link, if any, ends now ('replaced'). `by`: whoever it is on the record as coming from. */
async function linkNow(workspaceId, fields, req, transaction, by = req.user.id) {
  const now = new Date();
  const open = await openLink(workspaceId, transaction, true);
  let replaced = null;
  if (open) {
    const before = auditState(open);
    await open.update({ endedAt: now, endReason: 'replaced', endedByUserId: by }, { transaction });
    await audit('agent_link.end', req, open, before, auditState(open), transaction, { reason: 'replaced' });
    replaced = open.id;
  }
  const link = await db.AgentLink.create(
    {
      workspaceId,
      agentId: fields.agentId,
      source: 'manual',
      startsAt: fields.startsAt ? new Date(fields.startsAt) : now,
      endsAt: fields.endsAt ? new Date(fields.endsAt) : null,
      terms: fields.terms,
      commissionBasis: fields.commissionBasis,
      note: fields.note,
      createdByUserId: by,
    },
    { transaction }
  );
  await audit('agent_link.create', req, link, null, auditState(link), transaction, { replacedLinkId: replaced });
  await link.reload({ include: LINK_INCLUDE, transaction });
  return serializeLink(link);
}

/**
 * POST /admin/workspaces/:id/agent-links — links the store to `agentId` by
 * hand, or asks for it (see the header).
 */
async function createManual(workspaceId, body, req) {
  assertV2();
  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id'], transaction, lock: transaction.LOCK.UPDATE });
    if (!workspace) throw new NotFoundError('Workspace');
    const fields = await linkFields(body, transaction);
    if (!isCreator(req.user)) return askFor('link', workspaceId, null, fields, req, transaction);
    return { link: await linkNow(workspaceId, fields, req, transaction) };
  });
}

async function lockOpenLink(linkId, transaction, endedMessage) {
  const link = await db.AgentLink.findByPk(linkId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!link) throw new NotFoundError('Agent link');
  if (link.endedAt) throw new ConflictError(endedMessage, 'AGENT_LINK_ENDED');
  return link;
}

const UPDATE_ENDED = 'This link has ended. Link the store again instead.';
const END_ENDED = 'This link has already ended.';

function linkChanges(link, patch) {
  const next = {};
  if ('endsAt' in patch) next.endsAt = patch.endsAt ? new Date(patch.endsAt) : null;
  if ('terms' in patch) next.terms = checkedTerms(patch);
  if ('commissionBasis' in patch) next.commissionBasis = patch.commissionBasis;
  if ('note' in patch) next.note = patch.note || null;
  // A link of the old kind takes a schedule only by becoming a new-kind one.
  if (next.terms) next.legacy = false;
  checkDates(link.startsAt, 'endsAt' in next ? next.endsAt : link.endsAt);
  return next;
}

async function updateNow(link, patch, req, transaction) {
  const before = auditState(link);
  await link.update(linkChanges(link, patch), { transaction });
  await audit('agent_link.update', req, link, before, auditState(link), transaction);
  await link.reload({ include: LINK_INCLUDE, transaction });
  return serializeLink(link);
}

/** PATCH /admin/agent-links/:id — an open link's end date, schedule, basis or note, for the payments to come; or asks for it. */
async function update(linkId, patch, req) {
  assertV2();
  return db.sequelize.transaction(async (transaction) => {
    const link = await lockOpenLink(linkId, transaction, UPDATE_ENDED);
    // Refused now if it could never apply; applied on approval otherwise.
    linkChanges(link, patch);
    if (!isCreator(req.user)) return askFor('update', link.workspaceId, link.id, patch, req, transaction);
    return { link: await updateNow(link, patch, req, transaction) };
  });
}

async function endNow(link, note, req, transaction, by = req.user.id) {
  const before = auditState(link);
  await link.update({ endedAt: new Date(), endReason: 'ended', endedByUserId: by, ...(note ? { note } : {}) }, { transaction });
  await audit('agent_link.end', req, link, before, auditState(link), transaction, { reason: 'ended' });
  await link.reload({ include: LINK_INCLUDE, transaction });
  return serializeLink(link);
}

/** POST /admin/agent-links/:id/end — ends an open link now, or asks for it. Ending one is allowed with the flag off. */
async function end(linkId, { note }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const link = await lockOpenLink(linkId, transaction, END_ENDED);
    if (!isCreator(req.user)) return askFor('end', link.workspaceId, link.id, { note: note || null }, req, transaction);
    return { link: await endNow(link, note, req, transaction) };
  });
}

// -------------------------------------------------------------- the review

async function lockWaiting(requestId, req, transaction) {
  const request = await db.AgentLinkRequest.findByPk(requestId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!request) throw new NotFoundError('Agent link request');
  if (request.status !== 'pending') throw new ConflictError('This request is not waiting for review.', 'AGENT_LINK_REQUEST_NOT_PENDING');
  await request.reload({ include: REQUEST_INCLUDE, transaction });
  if (!isCreator(req.user) && authorsOf(request).includes(req.user.id)) {
    throw new AppError('REVIEW_OF_OWN_WORK', 'You asked for this or made this link, so someone else has to review it.', 403);
  }
  return request;
}

async function closeRequest(request, status, reason, action, req, transaction) {
  const before = { status: request.status };
  await request.update({ status, reason, reviewedByUserId: req.user.id, reviewedAt: new Date() }, { transaction });
  await auditRequest(action, req, request, before, transaction);
  await request.reload({ include: REQUEST_INCLUDE, transaction });
  const [serialized] = await withAgents([request]);
  await reviewNotifications.linkDecided(serialized, request.requestedByUserId, req, transaction);
  return serialized;
}

/**
 * POST /admin/agent-link-requests/:id/approve — applies what was asked for, on
 * the store as it stands now. It is on the record as coming from whoever asked.
 */
async function approveRequest(requestId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const request = await lockWaiting(requestId, req, transaction);
    const by = request.requestedByUserId || req.user.id;
    let link;
    if (request.kind === 'link') {
      assertV2();
      link = await linkNow(request.workspaceId, await linkFields(request.changes, transaction), req, transaction, by);
    } else if (request.kind === 'update') {
      assertV2();
      link = await updateNow(await lockOpenLink(request.agentLinkId, transaction, UPDATE_ENDED), request.changes, req, transaction);
    } else {
      link = await endNow(await lockOpenLink(request.agentLinkId, transaction, END_ENDED), request.changes.note, req, transaction, by);
    }
    return { link, request: await closeRequest(request, 'approved', null, 'agent_link.approve', req, transaction) };
  });
}

/** POST /admin/agent-link-requests/:id/reject — nothing changes on the store. */
async function rejectRequest(requestId, { reason }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const request = await lockWaiting(requestId, req, transaction);
    return { request: await closeRequest(request, 'rejected', reason || null, 'agent_link.reject', req, transaction) };
  });
}

/** GET /admin/agent-link-requests — by status, the oldest waiting first. */
async function listRequests({ status = 'pending', limit = 50, offset = 0 } = {}) {
  const { rows, count } = await db.AgentLinkRequest.findAndCountAll({
    where: { status },
    include: REQUEST_INCLUDE,
    order: [['createdAt', 'ASC'], ['id', 'ASC']],
    limit,
    offset,
  });
  return { requests: await withAgents(rows), total: count, limit, offset };
}

/** A store's latest requests, newest first, for its page. */
async function requestsForWorkspace(workspaceId) {
  const rows = await db.AgentLinkRequest.findAll({ where: { workspaceId }, include: REQUEST_INCLUDE, order: [['createdAt', 'DESC'], ['id', 'ASC']], limit: 10 });
  return withAgents(rows);
}

module.exports = {
  serializeLink,
  openLink,
  linkAt,
  linkFromCode,
  linkTermsOf,
  listForWorkspace,
  createManual,
  update,
  end,
  approveRequest,
  rejectRequest,
  listRequests,
  requestsForWorkspace,
  LINK_INCLUDE,
};
