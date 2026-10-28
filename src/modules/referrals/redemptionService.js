'use strict';

const { Op, QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { AppError, ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { planPrice } = require('../billing/planPricing');
const { normalizeCode, CODE_PATTERN } = require('./referralCodeService');
const { emailKey } = require('./emailKey');
const pricing = require('./referralPricing');
const agentLinks = require('./agentLinkService');

/**
 * A store entering a referral code (referral_code_redemptions, migration 725):
 * at sign-up (the new store), on the plans page, or with a plan switch. One
 * path for all three, inside the caller's transaction.
 *
 * Always (as before): the code must exist and be active; the same code again
 * is a no-op; one code at a time per store.
 *
 * With REFERRAL_CODES_V2_ENABLED, also, each with its own error:
 *   - its dates (starts_at / ends_at) and its use limit (max_uses, counted by
 *     the UPDATE that checks it, so two stores entering the last use at once
 *     cannot both get it);
 *   - its audience (merchantKind below) and restrictions (plans, cycle,
 *     minimum price; a wallet benefit is for pay per order, extra trial days
 *     for a store not yet paying);
 *   - once per store, once per account (the store's owner) and once per
 *     normalized email (emailKey: a.b+1@gmail.com is ab@gmail.com), whatever
 *     store it was entered on; enforced by unique indexes too;
 *   - a store whose current code still takes something off a payment to come
 *     keeps it (REFERRAL_CODE_ALREADY_SET); once that is over, a new code
 *     replaces it from the next charge.
 * Off, a code of the second kind (any setting the first kind did not have)
 * cannot be entered, and the first kind is entered as before.
 *
 * A charge already priced keeps its price: a new code applies from the next
 * charge. Entering a code with an agent links the store to that agent when
 * the store has no agent yet (agentLinkService.linkFromCode); an existing
 * link stays. The store's first code is marked once (is_first) and never
 * moves. Every use is audited in the workspace (subscription.referral_code_attach,
 * which also tells the console's bell).
 */

const SOURCES = ['signup', 'plan_page', 'plan_switch'];
const AUDIENCES = ['new', 'existing', 'any'];
const GRANT_TYPES = ['trial_days', 'wallet_credit', 'free_orders'];
const DAY_MS = 24 * 60 * 60 * 1000;

const refuse = (code, message, details) => new AppError(code, message, 422, details);
const invalid = () => refuse('REFERRAL_CODE_INVALID', "That referral code isn't valid. Check it and try again.");

/** Anything the first kind of code did not have: such a code is entered only with the flag on. */
function isSecondKind(code) {
  return Boolean(
    code.terms != null ||
      code.agentId == null ||
      code.audience !== 'any' ||
      code.startsAt ||
      code.endsAt ||
      code.maxUses != null ||
      (code.allowedPlanIds && code.allowedPlanIds.length) ||
      (code.allowedCycles && code.allowedCycles.length) ||
      code.minPriceAmount != null ||
      code.grantType != null ||
      code.commissionBasis !== 'paid' ||
      code.linksAgent === false
  );
}

const isPayPerOrder = (plan) => Boolean(plan && Number(plan.perOrderFeeAmount) > 0);

/**
 * 'new' or 'existing', for the audience rule. A merchant is NEW while the
 * store's owner has no other store (of any status) and has never paid a
 * subscription charge on any store: someone signing up for the first time,
 * this store included until its first payment. Anyone else is EXISTING.
 */
async function merchantKind(workspaceId, ownerUserId, transaction) {
  const [row] = await db.sequelize.query(
    `SELECT
       (SELECT COUNT(*)::int FROM workspaces WHERE owner_user_id = :owner AND id <> :workspaceId) AS "otherStores",
       (SELECT COUNT(*)::int FROM billing_invoices i JOIN workspaces w ON w.id = i.workspace_id
         WHERE w.owner_user_id = :owner AND i.status = 'paid') AS "paidCharges"`,
    { replacements: { owner: ownerUserId, workspaceId }, type: QueryTypes.SELECT, transaction }
  );
  return row.otherStores === 0 && row.paidCharges === 0 ? 'new' : 'existing';
}

async function findCode(input, transaction, { lock = false } = {}) {
  const code = normalizeCode(input);
  if (!CODE_PATTERN.test(code)) return null;
  return db.ReferralCode.findOne({ where: { code }, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
}

/** The plan and cycle a code is judged against: the one being chosen, else the store's. */
async function targetOf(subscription, { planId, billingCycle }, transaction) {
  const id = planId || subscription.planId;
  const plan = id ? await db.Plan.findByPk(id, { transaction }) : null;
  return { plan, cycle: billingCycle || subscription.billingCycle || 'monthly' };
}

function checkWindow(code, now) {
  if (code.startsAt && new Date(code.startsAt) > now) {
    throw refuse('REFERRAL_CODE_NOT_STARTED', "This code can't be used yet.", { startsAt: code.startsAt });
  }
  if (code.endsAt && new Date(code.endsAt) <= now) {
    throw refuse('REFERRAL_CODE_EXPIRED', 'This code has expired.', { endsAt: code.endsAt });
  }
  if (code.maxUses != null && code.usesCount >= code.maxUses) {
    throw refuse('REFERRAL_CODE_LIMIT_REACHED', 'This code has been used as many times as it allows.');
  }
}

function checkAudience(code, kind) {
  if (code.audience === 'new' && kind !== 'new') {
    throw refuse('REFERRAL_CODE_NEW_MERCHANTS_ONLY', 'This code is for new merchants only.', { audience: code.audience });
  }
  if (code.audience === 'existing' && kind !== 'existing') {
    throw refuse('REFERRAL_CODE_EXISTING_MERCHANTS_ONLY', 'This code is for existing merchants only.', { audience: code.audience });
  }
}

function checkRestrictions(code, { plan, cycle }, subscription) {
  if (code.allowedPlanIds && code.allowedPlanIds.length && (!plan || !code.allowedPlanIds.includes(plan.id))) {
    throw refuse('REFERRAL_CODE_NOT_FOR_PLAN', "This code isn't for your plan.");
  }
  if (code.allowedCycles && code.allowedCycles.length && !code.allowedCycles.includes(cycle)) {
    throw refuse('REFERRAL_CODE_NOT_FOR_CYCLE', `This code is for ${code.allowedCycles.join(' or ')} billing only.`, { cycles: code.allowedCycles });
  }
  if (code.minPriceAmount != null) {
    const price = plan ? planPrice(plan, cycle) : 0;
    if (!plan || plan.currency !== code.minPriceCurrency || price < Number(code.minPriceAmount)) {
      throw refuse('REFERRAL_CODE_BELOW_MIN_PRICE', "This code needs a higher-priced plan.", {
        minPrice: { amount: Number(code.minPriceAmount), currency: code.minPriceCurrency },
      });
    }
  }
  if ((code.grantType === 'wallet_credit' || code.grantType === 'free_orders') && !isPayPerOrder(plan)) {
    throw refuse('REFERRAL_CODE_NOT_FOR_PLAN', 'This code is for the pay-per-order plan.');
  }
  if (code.grantType === 'trial_days' && !['trialing', 'draft'].includes(subscription.status)) {
    throw refuse('REFERRAL_CODE_TRIAL_ONLY', 'This code adds trial days, so it is for stores still on their trial.');
  }
}

/** The once-per-store / account / email rule, against every earlier use (backfilled ones included). */
async function checkUsedBefore(code, { workspaceId, ownerUserId, key }, transaction) {
  const or = [{ workspaceId }];
  if (ownerUserId) or.push({ ownerUserId });
  if (key) or.push({ emailKey: key });
  const earlier = await db.ReferralCodeRedemption.findOne({ where: { codeId: code.id, [Op.or]: or }, attributes: ['workspaceId', 'ownerUserId', 'emailKey'], transaction });
  if (!earlier) return;
  const by = earlier.workspaceId === workspaceId ? 'store' : ownerUserId && earlier.ownerUserId === ownerUserId ? 'account' : 'email';
  throw refuse('REFERRAL_CODE_ALREADY_USED', 'This code has already been used.', { by });
}

/**
 * Every check a code must pass for this store, writing nothing. Resolves the
 * code and what entering it would do: { code, kind, replaces, sameCode }.
 */
async function assess(subscription, input, { planId = null, billingCycle = null, now = new Date() } = {}, transaction) {
  const code = await findCode(input, transaction);
  if (!code || !code.active) throw invalid();
  const v2 = pricing.v2Enabled();
  if (!v2 && isSecondKind(code)) throw invalid();
  if (subscription.referralCodeId === code.id) return { code, sameCode: true, kind: null, replaces: null };

  const workspace = await db.Workspace.findByPk(subscription.workspaceId, {
    attributes: ['id', 'ownerUserId'],
    include: [{ model: db.User, as: 'owner', attributes: ['id', 'email'] }],
    transaction,
  });
  const ownerUserId = workspace ? workspace.ownerUserId : null;
  const key = workspace && workspace.owner ? emailKey(workspace.owner.email) : null;
  let kind = null;
  if (v2) {
    checkWindow(code, now);
    kind = await merchantKind(subscription.workspaceId, ownerUserId, transaction);
    checkAudience(code, kind);
    checkRestrictions(code, await targetOf(subscription, { planId, billingCycle }, transaction), subscription);
    await checkUsedBefore(code, { workspaceId: subscription.workspaceId, ownerUserId, key }, transaction);
  }

  let replaces = null;
  if (subscription.referralCodeId) {
    const current = await db.ReferralCode.findByPk(subscription.referralCodeId, { transaction });
    const redemption = await pricing.currentRedemption(subscription.id, transaction);
    if (!v2 || (await pricing.stillDiscounting(current, redemption && redemption.codeId === subscription.referralCodeId ? redemption : null, transaction))) {
      throw new ConflictError('This workspace already has a referral code.', 'REFERRAL_CODE_ALREADY_SET');
    }
    replaces = redemption;
  }
  return { code, sameCode: false, kind, replaces, ownerUserId, key };
}

/** Raises the use count, or refuses at the limit; the row stays locked until the transaction ends. */
async function takeUse(code, transaction) {
  const [rows] = await db.sequelize.query(
    `UPDATE referral_codes SET uses_count = uses_count + 1, updated_at = NOW()
      WHERE id = :id AND (max_uses IS NULL OR uses_count < max_uses)
      RETURNING uses_count`,
    { replacements: { id: code.id }, transaction }
  );
  if (rows.length === 0) throw refuse('REFERRAL_CODE_LIMIT_REACHED', 'This code has been used as many times as it allows.');
}

const usedRace = (err) =>
  err && err.name === 'SequelizeUniqueConstraintError' ? refuse('REFERRAL_CODE_ALREADY_USED', 'This code has already been used.', { by: 'account' }) : err;

async function grant(redemption, subscription, transaction) {
  if (!redemption.grantType) return;
  const value = Number(redemption.grantValue);
  if (redemption.grantType === 'trial_days') {
    // A trial running now gets its days at once; a draft gets them when its trial starts (goLiveService).
    if (subscription.status !== 'trialing' || !subscription.trialEndsAt) return;
    const end = new Date(new Date(subscription.trialEndsAt).getTime() + value * DAY_MS);
    await subscription.update({ trialEndsAt: end, currentPeriodEnd: end }, { transaction });
  } else {
    // eslint-disable-next-line global-require
    const wallet = require('../billing/walletService');
    const row = await wallet.lockWallet(subscription.workspaceId, transaction);
    const credit = redemption.grantType === 'wallet_credit';
    await wallet.writeEntry(
      row,
      {
        type: credit ? 'gift' : 'free_orders_grant',
        delta: credit ? value : 0,
        freeDelta: credit ? 0 : value,
        note: 'Referral code',
        key: `referral_grant:${redemption.id}`,
      },
      transaction
    );
  }
  await redemption.update({ grantAppliedAt: new Date() }, { transaction });
}

/**
 * Extra trial days a draft's code is still holding (applied when its trial
 * starts): goLiveService.startTrial adds them and marks them given.
 */
async function takePendingTrialDays(subscription, transaction) {
  const redemption = await db.ReferralCodeRedemption.findOne({
    where: { subscriptionId: subscription.id, endedAt: null, grantType: 'trial_days', grantAppliedAt: null },
    transaction,
  });
  if (!redemption) return 0;
  await redemption.update({ grantAppliedAt: new Date() }, { transaction });
  return Number(redemption.grantValue);
}

/**
 * Enters `input` for the store of `workspaceId`, inside `transaction`.
 * `source`: signup | plan_page | plan_switch. `planId` / `billingCycle`: the
 * plan being chosen with it (the restrictions are judged against that).
 * Resolves { subscription, code, redemption, attached } — attached false for
 * the same code again.
 */
async function redeemInTransaction(workspaceId, input, { source, req, planId = null, billingCycle = null, now = new Date() }, transaction) {
  const subscription = await db.Subscription.findOne({ where: { workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!subscription) throw new NotFoundError('Subscription');
  const found = await assess(subscription, input, { planId, billingCycle, now }, transaction);
  const { code } = found;
  if (found.sameCode) return { subscription, code, redemption: null, attached: false };

  // The code row is locked by this UPDATE until the end: its count is exact.
  await takeUse(code, transaction);
  const v2 = pricing.v2Enabled();
  if (found.replaces) await found.replaces.update({ endedAt: now, endReason: 'replaced' }, { transaction });
  const firstAlready = await db.ReferralCodeRedemption.count({ where: { workspaceId, isFirst: true }, transaction });

  let redemption;
  try {
    redemption = await db.ReferralCodeRedemption.create(
      {
        codeId: code.id,
        workspaceId,
        subscriptionId: subscription.id,
        ownerUserId: found.ownerUserId,
        actorUserId: req && req.user ? req.user.id : null,
        emailKey: found.key,
        agentId: code.agentId,
        source: SOURCES.includes(source) ? source : 'plan_page',
        merchantKind: found.kind,
        isFirst: firstAlready === 0,
        singleUse: v2,
        billingCycle: billingCycle || subscription.billingCycle,
        terms: code.terms,
        commissionBasis: code.commissionBasis,
        grantType: code.grantType,
        grantValue: code.grantValue,
      },
      { transaction }
    );
  } catch (err) {
    throw usedRace(err);
  }

  await subscription.update({ referralCodeId: code.id, referralCodeAttachedAt: now }, { transaction });
  await agentLinks.linkFromCode(workspaceId, code, redemption, transaction, now);
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'subscription.referral_code_attach',
    entityType: 'Subscription',
    entityId: subscription.id,
    before: { referralCode: null },
    after: { referralCode: code.code },
    // No agent here: the merchant reads their own audit log.
    metadata: { source: redemption.source, redemptionId: redemption.id, first: redemption.isFirst, replaced: Boolean(found.replaces) },
    req,
    transaction,
  });
  // Last: a wallet benefit takes the wallet's lock, the last lock of its transaction.
  await grant(redemption, subscription, transaction);
  return { subscription, code, redemption, attached: true };
}

/** What entering `input` would do, writing nothing (the previews). */
async function preview(workspaceId, input, { planId = null, billingCycle = null } = {}) {
  const subscription = await db.Subscription.findOne({ where: { workspaceId } });
  if (!subscription) throw new NotFoundError('Subscription');
  const found = await assess(subscription, input, { planId, billingCycle });
  return { subscription, ...found };
}

// ---------------------------------------------------------------- history

function serializeRedemption(r, { paid = 0 } = {}) {
  return {
    id: r.id,
    code: r.code ? { id: r.code.id, code: r.code.code, label: r.code.label } : { id: r.codeId },
    workspace: r.workspace ? { id: r.workspace.id, name: r.workspace.name } : { id: r.workspaceId },
    owner: r.owner ? { id: r.owner.id, fullName: r.owner.fullName, email: r.owner.email } : r.ownerUserId ? { id: r.ownerUserId } : null,
    agent: r.agent ? { id: r.agent.id, fullName: r.agent.fullName } : r.agentId ? { id: r.agentId } : null,
    source: r.source,
    merchantKind: r.merchantKind,
    isFirst: r.isFirst,
    current: r.endedAt == null,
    endedAt: r.endedAt,
    endReason: r.endReason,
    billingCycle: r.billingCycle,
    // The schedule it was entered with (null: the code as it stands, the first kind).
    terms: r.terms,
    commissionBasis: r.commissionBasis,
    grant: r.grantType ? { type: r.grantType, value: Number(r.grantValue), appliedAt: r.grantAppliedAt } : null,
    firstInvoice: r.firstInvoice
      ? {
          id: r.firstInvoice.id,
          paidAt: r.firstInvoice.paidAt,
          grossAmount: Number(r.firstInvoice.grossAmount),
          discountAmount: Number(r.firstInvoice.discountAmount),
          amount: Number(r.firstInvoice.amount),
          currency: r.firstInvoice.currency,
        }
      : null,
    paymentsMade: paid,
    subscriptionStatus: r.subscription ? r.subscription.status : null,
    createdAt: r.createdAt,
  };
}

const HISTORY_INCLUDE = () => [
  { model: db.ReferralCode, as: 'code', attributes: ['id', 'code', 'label'] },
  { model: db.Workspace, as: 'workspace', attributes: ['id', 'name'] },
  { model: db.User, as: 'owner', attributes: ['id', 'fullName', 'email'] },
  { model: db.User, as: 'agent', attributes: ['id', 'fullName'] },
  { model: db.Subscription, as: 'subscription', attributes: ['id', 'status'] },
  { model: db.BillingInvoice, as: 'firstInvoice', attributes: ['id', 'paidAt', 'grossAmount', 'discountAmount', 'amount', 'currency'] },
];

async function paidCounts(ids) {
  if (ids.length === 0) return new Map();
  const rows = await db.sequelize.query(
    `SELECT referral_redemption_id AS id, COUNT(*)::int AS n FROM billing_invoices
      WHERE referral_redemption_id IN (:ids) AND status = 'paid' GROUP BY referral_redemption_id`,
    { replacements: { ids }, type: QueryTypes.SELECT }
  );
  return new Map(rows.map((r) => [r.id, r.n]));
}

async function serializeAll(rows) {
  const paid = await paidCounts(rows.map((r) => r.id));
  return rows.map((r) => serializeRedemption(r, { paid: paid.get(r.id) || 0 }));
}

/** Every code a store has entered, newest first. */
async function forWorkspace(workspaceId) {
  const rows = await db.ReferralCodeRedemption.findAll({ where: { workspaceId }, include: HISTORY_INCLUDE(), order: [['createdAt', 'DESC'], ['id', 'ASC']] });
  return serializeAll(rows);
}

/** Every code entered on any store this account owns(ed), newest first. */
async function forUser(userId) {
  const rows = await db.ReferralCodeRedemption.findAll({ where: { ownerUserId: userId }, include: HISTORY_INCLUDE(), order: [['createdAt', 'DESC'], ['id', 'ASC']] });
  return serializeAll(rows);
}

const LIST_MAX = 200;

/**
 * The stores that entered one code: search by store name or owner email,
 * filter by current/ended, merchant kind and where it was entered.
 */
async function forCode(codeId, { q, status, merchantKind: kind, source, limit = 50, offset = 0 } = {}) {
  const where = { codeId };
  if (status === 'current') where.endedAt = null;
  else if (status === 'ended') where.endedAt = { [Op.ne]: null };
  if (kind) where.merchantKind = kind;
  if (source) where.source = source;
  const term = q && q.trim() ? `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  if (term) {
    where[Op.or] = [{ '$workspace.name$': { [Op.iLike]: term } }, { '$owner.email$': { [Op.iLike]: term } }];
  }
  const { rows, count } = await db.ReferralCodeRedemption.findAndCountAll({
    where,
    include: HISTORY_INCLUDE(),
    order: [['createdAt', 'DESC'], ['id', 'ASC']],
    limit: Math.min(limit, LIST_MAX),
    offset,
    subQuery: false,
    distinct: true,
  });
  return { redemptions: await serializeAll(rows), total: count, limit: Math.min(limit, LIST_MAX), offset };
}

/**
 * What switching a code off would cost: stores using it now, and of those
 * the ones on a trial (or a draft) that have not paid with it yet — they
 * lose its discount on the payment to come.
 */
async function impactOf(codeId) {
  const [row] = await db.sequelize.query(
    `SELECT COUNT(*)::int AS current,
            COUNT(*) FILTER (WHERE s.status IN ('trialing', 'draft')
              AND NOT EXISTS (SELECT 1 FROM billing_invoices i WHERE i.referral_redemption_id = r.id AND i.status = 'paid'))::int AS "trialingUnpaid"
       FROM referral_code_redemptions r JOIN subscriptions s ON s.id = r.subscription_id
      WHERE r.code_id = :codeId AND r.ended_at IS NULL AND s.referral_code_id = r.code_id`,
    { replacements: { codeId }, type: QueryTypes.SELECT }
  );
  return { currentStores: row.current, trialingUnpaid: row.trialingUnpaid };
}

module.exports = {
  SOURCES,
  AUDIENCES,
  GRANT_TYPES,
  isSecondKind,
  merchantKind,
  assess,
  preview,
  redeemInTransaction,
  takePendingTrialDays,
  serializeRedemption,
  forWorkspace,
  forUser,
  forCode,
  impactOf,
};
