'use strict';

const { Op } = require('sequelize');
const db = require('../../db/models');
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { planPrice } = require('../billing/planPricing');
const referralCodes = require('./referralCodeService');
const agents = require('./agentService');
const redemptions = require('./redemptionService');
const agentLinks = require('./agentLinkService');
const terms = require('./referralTerms');
const { DEFAULT_COMMISSION_RATE_BP } = require('./commissionPolicy');

/**
 * The console's Referral codes screens (Agents → Referral codes, migration
 * 725): every code with or without an agent, one code with the stores that
 * entered it, a store's and an account's history, and the simulator.
 * Read-only here; writes are referralCodeService, redemptionService and
 * agentLinkService.
 */

const LIST_LIMIT_MAX = 200;
const AGENT = { model: db.User, as: 'agent', attributes: ['id', 'fullName', 'email', 'platformRole'] };

function withAgent(code) {
  return { ...referralCodes.serializeCode(code), agent: code.agent ? { id: code.agent.id, fullName: code.agent.fullName, email: code.agent.email } : null };
}

/** State filter as a where clause (stateOf, in SQL). */
function stateWhere(state, now) {
  switch (state) {
    case 'inactive':
      return { active: false };
    case 'scheduled':
      return { active: true, startsAt: { [Op.gt]: now } };
    case 'expired':
      return { active: true, endsAt: { [Op.lte]: now } };
    case 'full':
      return { active: true, maxUses: { [Op.ne]: null }, usesCount: { [Op.gte]: db.sequelize.col('max_uses') } };
    case 'active':
      return {
        active: true,
        [Op.and]: [
          { [Op.or]: [{ startsAt: null }, { startsAt: { [Op.lte]: now } }] },
          { [Op.or]: [{ endsAt: null }, { endsAt: { [Op.gt]: now } }] },
          { [Op.or]: [{ maxUses: null }, { usesCount: { [Op.lt]: db.sequelize.col('max_uses') } }] },
        ],
      };
    default:
      return {};
  }
}

/** GET /admin/referral-codes — search (code or label), agent ('none' = no agent), state, audience. */
async function listCodes({ q, agentId, state, audience, limit = 50, offset = 0 } = {}) {
  const now = new Date();
  const where = { ...stateWhere(state, now) };
  if (agentId === 'none') where.agentId = null;
  else if (agentId) where.agentId = agentId;
  if (audience) where.audience = audience;
  const term = q && q.trim() ? `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  if (term) where[Op.or] = [{ code: { [Op.iLike]: term } }, { label: { [Op.iLike]: term } }];
  const take = Math.min(limit, LIST_LIMIT_MAX);
  const { rows, count } = await db.ReferralCode.findAndCountAll({
    where,
    include: [AGENT],
    order: [['createdAt', 'DESC'], ['id', 'ASC']],
    limit: take,
    offset,
  });
  const stats = await agents.codeStats(rows.map((c) => c.id));
  return {
    codes: rows.map((c) => ({
      ...withAgent(c),
      merchantsReferred: stats.referred.get(c.id) || 0,
      commission: stats.commission.get(c.id) || [],
    })),
    total: count,
    limit: take,
    offset,
    defaultCommissionRateBp: DEFAULT_COMMISSION_RATE_BP,
    v2Enabled: referralCodes.v2Enabled(),
  };
}

/** GET /admin/referral-codes/:id — the code, its numbers and what switching it off would cost. */
async function getCode(codeId) {
  const code = await db.ReferralCode.findByPk(codeId, { include: [AGENT] });
  if (!code) throw new NotFoundError('Referral code');
  const [stats, impact] = await Promise.all([agents.codeStats([code.id]), redemptions.impactOf(code.id)]);
  return {
    code: {
      ...withAgent(code),
      merchantsReferred: stats.referred.get(code.id) || 0,
      commission: stats.commission.get(code.id) || [],
    },
    impact,
    defaultCommissionRateBp: DEFAULT_COMMISSION_RATE_BP,
    v2Enabled: referralCodes.v2Enabled(),
  };
}

/** GET /admin/workspaces/:id/referrals — every code the store entered and every agent link it had. */
async function forWorkspace(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id'] });
  if (!workspace) throw new NotFoundError('Workspace');
  const [used, links] = await Promise.all([redemptions.forWorkspace(workspaceId), agentLinks.listForWorkspace(workspaceId)]);
  return { redemptions: used, links, openLink: links.find((l) => l.open) || null, v2Enabled: referralCodes.v2Enabled() };
}

/** GET /admin/users/:id/referrals — every code entered on the stores this account owns. */
async function forUser(userId) {
  const user = await db.User.findByPk(userId, { attributes: ['id'] });
  if (!user) throw new NotFoundError('User');
  return { redemptions: await redemptions.forUser(userId) };
}

/**
 * POST /admin/referral-codes/simulate — the first payments of one plan on one
 * cycle under `terms` (unsaved form values), before saving. `hasAgent`
 * false: no commission column.
 */
async function simulate({ planId, billingCycle, terms: schedule, commissionBasis = 'paid', hasAgent = true, payments }) {
  const errors = terms.validateTerms(schedule);
  if (errors.length) throw new ValidationError(errors, 'Invalid body');
  const plan = await db.Plan.findByPk(planId);
  if (!plan) throw new NotFoundError('Plan');
  const result = terms.simulate({
    terms: terms.normalizeTerms(schedule),
    cycle: billingCycle,
    gross: planPrice(plan, billingCycle),
    monthlyPrice: Number(plan.monthlyPriceAmount),
    currency: plan.currency,
    commissionBasis,
    hasAgent,
    payments: payments || terms.SIMULATED_PAYMENTS,
  });
  return { plan: { id: plan.id, name: plan.name, currency: plan.currency }, ...result };
}

module.exports = { listCodes, getCode, forWorkspace, forUser, simulate };
