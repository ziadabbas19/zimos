'use strict';

const { Op, QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { PLATFORM_ROLES, PLATFORM_PERMISSIONS } = require('../../core/security/platformPermissions');
const adminUsers = require('../platformAdmin/adminUsersService');
const { DEFAULT_COMMISSION_RATE_BP } = require('./commissionPolicy');
const referralCodes = require('./referralCodeService');

/**
 * Agents as the Agents screens see them: an account with the agent role, or
 * one that still owns referral codes after losing it (its ledger rows may
 * still be waiting to be paid, so it must not drop out of view).
 *
 * Per code: merchants referred (subscriptions the code is attached to) and
 * the suggested commission split pending / marked paid, per currency.
 *
 * `getAgent(id, { forAgent: true })` is the agent's own read-only view,
 * reached only through /admin/my/referrals with their own id.
 */

const AGENT_ATTRIBUTES = ['id', 'email', 'fullName', 'status', 'platformRole', 'lastLoginAt', 'createdAt'];

function serializeAgent(user) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    status: user.status,
    // false once the role was changed or revoked; the codes and ledger remain.
    isAgent: user.platformRole === PLATFORM_ROLES.AGENT,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

/** Adds per-currency totals row by row, never across currencies. */
function mergeTotals(into, rows) {
  for (const r of rows) {
    const t = into.get(r.currency) || { currency: r.currency, pending: 0, markedPaid: 0, amountPaid: 0, payments: 0 };
    t.pending += r.pending;
    t.markedPaid += r.markedPaid;
    t.amountPaid += r.amountPaid;
    t.payments += r.payments;
    into.set(r.currency, t);
  }
  return into;
}

async function codeStats(codeIds) {
  if (codeIds.length === 0) return { referred: new Map(), commission: new Map() };
  const [referredRows, commissionRows] = await Promise.all([
    db.sequelize.query(
      `SELECT referral_code_id AS "codeId", COUNT(*)::int AS n
         FROM subscriptions
        WHERE referral_code_id IN (:codeIds)
        GROUP BY referral_code_id`,
      { replacements: { codeIds }, type: QueryTypes.SELECT }
    ),
    db.sequelize.query(
      `SELECT code_id AS "codeId", currency,
              COALESCE(SUM(suggested_commission) FILTER (WHERE payout_status = 'pending'), 0) AS pending,
              COALESCE(SUM(suggested_commission) FILTER (WHERE payout_status = 'marked_paid'), 0) AS "markedPaid",
              COALESCE(SUM(amount_paid), 0) AS "amountPaid",
              COUNT(*)::int AS payments
         FROM agent_commissions
        WHERE code_id IN (:codeIds) AND voided_at IS NULL
        GROUP BY code_id, currency
        ORDER BY currency`,
      { replacements: { codeIds }, type: QueryTypes.SELECT }
    ),
  ]);

  const commission = new Map();
  for (const r of commissionRows) {
    const list = commission.get(r.codeId) || [];
    list.push({
      currency: r.currency,
      pending: Number(r.pending),
      markedPaid: Number(r.markedPaid),
      amountPaid: Number(r.amountPaid),
      payments: r.payments,
    });
    commission.set(r.codeId, list);
  }
  return { referred: new Map(referredRows.map((r) => [r.codeId, r.n])), commission };
}

function codeWithStats(code, stats) {
  return {
    ...referralCodes.serializeCode(code),
    merchantsReferred: stats.referred.get(code.id) || 0,
    commission: stats.commission.get(code.id) || [],
  };
}

/**
 * Per agent and currency, over every live row: the codes' rows and those of
 * stores linked by hand (no code, migration 725) alike.
 */
async function agentTotals(agentIds) {
  if (agentIds.length === 0) return new Map();
  const rows = await db.sequelize.query(
    `SELECT agent_id AS "agentId", currency,
            COALESCE(SUM(suggested_commission) FILTER (WHERE payout_status = 'pending'), 0) AS pending,
            COALESCE(SUM(suggested_commission) FILTER (WHERE payout_status = 'marked_paid'), 0) AS "markedPaid",
            COALESCE(SUM(amount_paid), 0) AS "amountPaid",
            COUNT(*)::int AS payments
       FROM agent_commissions
      WHERE agent_id IN (:agentIds) AND voided_at IS NULL
      GROUP BY agent_id, currency
      ORDER BY currency`,
    { replacements: { agentIds }, type: QueryTypes.SELECT }
  );
  const out = new Map();
  for (const r of rows) {
    const list = out.get(r.agentId) || [];
    list.push({ currency: r.currency, pending: Number(r.pending), markedPaid: Number(r.markedPaid), amountPaid: Number(r.amountPaid), payments: r.payments });
    out.set(r.agentId, list);
  }
  return out;
}

function agentWithCodes(user, codes, stats, totalsByAgent) {
  const withStats = codes.map((c) => codeWithStats(c, stats));
  const totals = new Map();
  for (const c of withStats) mergeTotals(totals, c.commission);
  return {
    ...serializeAgent(user),
    codes: withStats,
    merchantsReferred: withStats.reduce((n, c) => n + c.merchantsReferred, 0),
    commission: totalsByAgent ? totalsByAgent.get(user.id) || [] : [...totals.values()].sort((a, b) => (a.currency < b.currency ? -1 : 1)),
  };
}

async function listAgents() {
  const owners = await db.sequelize.query('SELECT DISTINCT agent_id AS "agentId" FROM referral_codes WHERE agent_id IS NOT NULL', {
    type: QueryTypes.SELECT,
  });
  const users = await db.User.findAll({
    where: {
      [Op.or]: [{ platformRole: PLATFORM_ROLES.AGENT }, { id: owners.map((o) => o.agentId) }],
    },
    attributes: AGENT_ATTRIBUTES,
    order: [
      ['fullName', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  const codes = await db.ReferralCode.findAll({
    where: { agentId: users.map((u) => u.id) },
    order: [
      ['createdAt', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  const stats = await codeStats(codes.map((c) => c.id));
  const totals = await agentTotals(users.map((u) => u.id));
  return {
    agents: users.map((u) =>
      agentWithCodes(
        u,
        codes.filter((c) => c.agentId === u.id),
        stats,
        totals
      )
    ),
    defaultCommissionRateBp: DEFAULT_COMMISSION_RATE_BP,
  };
}

/** The workspaces whose subscription carries one of `codes`, newest first. */
async function referredMerchants(codes) {
  if (codes.length === 0) return [];
  const subs = await db.Subscription.findAll({
    where: { referralCodeId: codes.map((c) => c.id) },
    include: [
      { model: db.Workspace, as: 'workspace', attributes: ['id', 'name'] },
      { model: db.Plan, as: 'plan', attributes: ['id', 'name'] },
    ],
    order: [
      ['referralCodeAttachedAt', 'DESC'],
      ['id', 'ASC'],
    ],
  });
  const byId = new Map(codes.map((c) => [c.id, c]));
  return subs.map((s) => ({
    workspace: { id: s.workspaceId, name: s.workspace ? s.workspace.name : null },
    code: { id: s.referralCodeId, code: byId.get(s.referralCodeId).code },
    attachedAt: s.referralCodeAttachedAt,
    subscriptionStatus: s.status,
    planName: s.plan ? s.plan.name : null,
    billingCycle: s.billingCycle,
    via: 'code',
  }));
}

/** The stores linked to the agent by hand (migration 725), newest first: no code (`code.id` null). */
async function linkedMerchants(agentId) {
  const links = await db.AgentLink.findAll({
    where: { agentId, source: 'manual' },
    include: [{ model: db.Workspace, as: 'workspace', attributes: ['id', 'name'] }],
    order: [['startsAt', 'DESC'], ['id', 'ASC']],
  });
  if (links.length === 0) return [];
  const subs = await db.Subscription.findAll({
    where: { workspaceId: links.map((l) => l.workspaceId) },
    include: [{ model: db.Plan, as: 'plan', attributes: ['id', 'name'] }],
  });
  const subOf = new Map(subs.map((s) => [s.workspaceId, s]));
  return links.map((l) => {
    const s = subOf.get(l.workspaceId);
    return {
      workspace: { id: l.workspaceId, name: l.workspace ? l.workspace.name : null },
      code: { id: null, code: null },
      attachedAt: l.startsAt,
      subscriptionStatus: s ? s.status : null,
      planName: s && s.plan ? s.plan.name : null,
      billingCycle: s ? s.billingCycle : null,
      via: 'manual',
      linkOpen: l.endedAt == null,
    };
  });
}

async function getAgent(agentId, { forAgent = false } = {}) {
  const user = await db.User.findByPk(agentId, { attributes: AGENT_ATTRIBUTES });
  const codes = user
    ? await db.ReferralCode.findAll({
        where: { agentId },
        order: [
          ['createdAt', 'ASC'],
          ['id', 'ASC'],
        ],
      })
    : [];
  if (!user || (user.platformRole !== PLATFORM_ROLES.AGENT && codes.length === 0 && !forAgent)) {
    throw new NotFoundError('Agent');
  }
  const stats = await codeStats(codes.map((c) => c.id));
  const totals = await agentTotals([user.id]);
  return {
    agent: agentWithCodes(user, codes, stats, totals),
    merchants: [...(await referredMerchants(codes)), ...(await linkedMerchants(agentId))],
    defaultCommissionRateBp: DEFAULT_COMMISSION_RATE_BP,
  };
}

/**
 * Gives an existing, active account the agent role and, optionally, its
 * first referral code, atomically. Gated by agents.manage, not admins.manage:
 * this path can only ever assign the agent role and the agent's default
 * permission set.
 */
async function createAgent({ email, firstCode }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const { user, granted } = await adminUsers.grantRoleInTransaction(
      { email, role: PLATFORM_ROLES.AGENT },
      req,
      transaction,
      // What this route asks of the requester, read again under the lock.
      { permission: PLATFORM_PERMISSIONS.AGENTS_MANAGE }
    );
    if (!granted) {
      throw new ConflictError('That account is already an agent. Add a code from their page instead.', 'ALREADY_AGENT');
    }
    let code = null;
    if (firstCode) {
      try {
        code = await referralCodes.createCodeInTransaction(user.id, firstCode, req, transaction);
      } catch (err) {
        throw referralCodes.uniqueViolationToConflict(err, firstCode.code);
      }
    }
    return {
      agent: serializeAgent(user),
      code: code ? referralCodes.serializeCode(code) : null,
    };
  });
}

module.exports = { listAgents, getAgent, createAgent, codeStats };
