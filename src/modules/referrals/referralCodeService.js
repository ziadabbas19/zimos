'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const { AppError, ConflictError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { applyBasisPoints } = require('../../core/utils/money');
const { recordAudit } = require('../audit/auditService');
const { PLATFORM_ROLES, isCreator } = require('../../core/security/platformPermissions');
const { commissionRateFor, DEFAULT_COMMISSION_RATE_BP } = require('./commissionPolicy');
const terms = require('./referralTerms');

/**
 * Agent referral codes (migration 106). Only platform users with
 * agents.manage create or change them (the routes check that); an agent can
 * read their own and nothing more.
 *
 * A code is stored uppercase and matched uppercase, so a merchant can type it
 * in any case. The code string never changes once created — merchants and
 * printed material use it — so a new area gets a new code. Deactivating a
 * code stops it being entered and stops it discounting or earning on any
 * charge paid from then on, including one already priced with it (the charge
 * service re-checks the code at payment); it stays attached to the
 * subscriptions that used it.
 *
 * Second kind (migration 725, REFERRAL_CODES_V2_ENABLED): any platform user
 * with agents.manage can also make a code with no agent (a discount only,
 * no commission), give it an agent later, and set its audience, dates, use
 * limit, restrictions, per-cycle schedules (referralTerms), commission basis,
 * whether it links the store to its agent, and a one-time benefit. A new code
 * made with the flag on takes its discount on the first payment only and is
 * for new merchants only unless told otherwise. A code of the first kind
 * stays that kind until the console gives it `terms`. Changing a code
 * changes what stores entering it from then on get: a store that entered it
 * keeps the terms it entered it with (redemptionService).
 *
 * The review (migration 742, referral_codes.approve): an account can make its
 * own codes through /my/* (referrals.view_own). A new one is pending and
 * switched off (active false), so nothing that reads `active` treats it as a
 * code at all. A change to an approved code that touches money, from anyone but
 * a creator and from the console or /my/* alike (applyChange), waits in
 * pending_changes: the code stays pending for anyone new, and stores already
 * using it keep what was approved, since nothing prices with a change nobody
 * approved. Rejecting that change leaves the code as it was approved. Codes
 * made from the console are approved as they are made, as before.
 */

const DISCOUNT_TYPES = ['none', 'percentage', 'fixed'];
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
const AUDIENCES = ['new', 'existing', 'any'];
const GRANT_TYPES = ['trial_days', 'wallet_credit', 'free_orders'];
const GRANT_LIMITS = { trial_days: 365, wallet_credit: 2000000, free_orders: 1000 };
const CODE_STATES = ['active', 'inactive', 'scheduled', 'expired', 'full'];
// What only a code of the second kind has; with the flag off none can be set.
const V2_FIELDS = [
  'audience',
  'startsAt',
  'endsAt',
  'maxUses',
  'allowedPlanIds',
  'allowedCycles',
  'minPriceAmount',
  'minPriceCurrency',
  'terms',
  'commissionBasis',
  'linksAgent',
  'grantType',
  'grantValue',
  'agentId',
];

function v2Enabled() {
  return env.billing.referralCodesV2.enabled === true;
}

function v2Disabled() {
  return new AppError('REFERRAL_V2_DISABLED', 'These referral code settings are not switched on.', 409);
}

/** active | inactive | scheduled (not started) | expired | full (its use limit is reached). */
function stateOf(code, now = new Date()) {
  if (!code.active) return 'inactive';
  if (code.startsAt && new Date(code.startsAt) > now) return 'scheduled';
  if (code.endsAt && new Date(code.endsAt) <= now) return 'expired';
  if (code.maxUses != null && code.usesCount >= code.maxUses) return 'full';
  return 'active';
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

function codeFields(code) {
  return {
    id: code.id,
    agentId: code.agentId,
    code: code.code,
    label: code.label,
    discountType: code.discountType,
    // BIGINT arrives from pg as a string — hand the client a number.
    discountValue: code.discountValue == null ? null : Number(code.discountValue),
    discountCurrency: code.discountCurrency,
    // The override as stored (null = platform default) and the rate in force.
    commissionRateBp: code.commissionRateBp,
    effectiveCommissionRateBp: commissionRateFor(code),
    active: code.active,
    // Second kind (migration 725). `terms` null = the first kind; `effectiveTerms`
    // is what prices it either way (its schedules, or its one discount and rate).
    kind: code.terms ? 'schedule' : 'legacy',
    state: stateOf(code),
    audience: code.audience || 'any',
    startsAt: code.startsAt || null,
    endsAt: code.endsAt || null,
    maxUses: code.maxUses == null ? null : code.maxUses,
    usesCount: code.usesCount || 0,
    allowedPlanIds: code.allowedPlanIds || [],
    allowedCycles: code.allowedCycles || [],
    minPrice: code.minPriceAmount == null ? null : { amount: Number(code.minPriceAmount), currency: code.minPriceCurrency },
    terms: code.terms || null,
    effectiveTerms: code.terms || terms.legacyTerms(code, DEFAULT_COMMISSION_RATE_BP),
    commissionBasis: code.commissionBasis || 'paid',
    linksAgent: code.linksAgent !== false,
    grant: code.grantType ? { type: code.grantType, value: Number(code.grantValue) } : null,
    createdAt: code.createdAt,
    updatedAt: code.updatedAt,
  };
}

function serializeCode(code) {
  const row = code.get ? code.get() : code;
  return {
    ...codeFields(code),
    approvalStatus: code.approvalStatus || 'approved',
    approvalNote: code.approvalNote || null,
    changesRejected: Boolean(code.changesRejected),
    reviewedAt: code.reviewedAt || null,
    // How it would read with the change waiting for review; it changes nothing until then.
    proposed: code.pendingChanges ? codeFields({ ...row, ...code.pendingChanges }) : null,
  };
}

/** Whether a store may enter it now: switched on, and nothing waiting for review. */
function canBeEntered(code) {
  return Boolean(code.active) && (code.approvalStatus || 'approved') === 'approved';
}

/**
 * What a merchant sees of a code: the discount, never the agent, label or
 * commission. `discountSchedule` is a second-kind code's discount steps per
 * cycle (null for the first kind, whose discountType/Value apply to every
 * payment); with `entered`, the schedule the store entered it with.
 */
function serializeCodeForMerchant(code, { entered = null } = {}) {
  const schedule = (entered && entered.terms) || code.terms;
  return {
    code: code.code,
    discountType: code.discountType,
    discountValue: code.discountValue == null ? null : Number(code.discountValue),
    discountCurrency: code.discountCurrency,
    active: code.active,
    discountSchedule: schedule ? { monthly: terms.forCycle(schedule, 'monthly').discount, yearly: terms.forCycle(schedule, 'yearly').discount } : null,
    grant: code.grantType ? { type: code.grantType, value: Number(code.grantValue) } : null,
    endsAt: code.endsAt || null,
  };
}

/**
 * The discount fields must agree with each other; the same rule as the
 * referral_codes_discount_check constraint, reported field by field.
 */
function assertDiscount({ discountType, discountValue, discountCurrency }) {
  const errors = [];
  if (!DISCOUNT_TYPES.includes(discountType)) {
    errors.push({ field: 'discountType', message: `discountType must be one of ${DISCOUNT_TYPES.join(', ')}` });
  } else if (discountType === 'none') {
    if (discountValue != null) errors.push({ field: 'discountValue', message: 'A code with no discount takes no discountValue' });
    if (discountCurrency != null) errors.push({ field: 'discountCurrency', message: 'A code with no discount takes no discountCurrency' });
  } else if (discountValue == null) {
    errors.push({ field: 'discountValue', message: `A ${discountType} discount needs a discountValue` });
  } else if (discountType === 'percentage') {
    if (!Number.isInteger(discountValue) || discountValue < 1 || discountValue > 10000) {
      errors.push({ field: 'discountValue', message: 'A percentage is in basis points, from 1 (0.01%) to 10000 (100%)' });
    }
    if (discountCurrency != null) errors.push({ field: 'discountCurrency', message: 'A percentage discount takes no currency' });
  } else {
    if (!Number.isInteger(discountValue) || discountValue < 1) {
      errors.push({ field: 'discountValue', message: 'A fixed discount is a positive amount in minor units' });
    }
    if (!/^[A-Z]{3}$/.test(discountCurrency || '')) {
      errors.push({ field: 'discountCurrency', message: 'A fixed discount needs a 3-letter currency code' });
    }
  }
  if (errors.length) throw new ValidationError(errors, 'Invalid body');
}

/**
 * The discount a code takes off a charge of `grossAmount` in `currency`:
 * never more than the charge itself, and nothing for a fixed amount in a
 * different currency (amounts are never converted). Integer minor units.
 */
function discountFor(code, grossAmount, currency) {
  const gross = Number(grossAmount);
  if (!code || !code.active || gross <= 0) return 0;
  const value = code.discountValue == null ? 0 : Number(code.discountValue);
  let discount = 0;
  if (code.discountType === 'percentage') discount = applyBasisPoints(gross, value);
  else if (code.discountType === 'fixed' && code.discountCurrency === currency) discount = value;
  return Math.max(0, Math.min(discount, gross));
}

async function auditCode(action, req, code, before, after, transaction) {
  await recordAudit({
    actorUserId: req.user.id,
    action,
    entityType: 'ReferralCode',
    entityId: code.id,
    before,
    after,
    metadata: { code: code.code, agentId: code.agentId },
    req,
    transaction,
  });
}

function auditState(code) {
  const { id, createdAt, updatedAt, effectiveCommissionRateBp, effectiveTerms, state, usesCount, proposed, ...rest } = serializeCode(code);
  return { ...rest, pendingChanges: code.pendingChanges || null };
}

async function assertAgent(agentId, transaction) {
  const agent = await db.User.findByPk(agentId, { attributes: ['id', 'platformRole'], transaction });
  if (!agent) throw new NotFoundError('Agent');
  if (agent.platformRole !== PLATFORM_ROLES.AGENT) {
    throw new ConflictError('Referral codes can only be given to an account with the agent role.', 'NOT_AN_AGENT');
  }
}

const has = (body, key) => Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;

/**
 * The second-kind fields of `body`, checked, as columns. `merged` is the
 * code they will sit on (for the dates).
 */
async function v2Columns(body, merged, transaction) {
  const out = {};
  const errors = [];
  for (const key of ['audience', 'startsAt', 'endsAt', 'maxUses', 'commissionBasis', 'linksAgent']) {
    if (has(body, key)) out[key] = body[key] === '' ? null : body[key];
  }
  if (has(body, 'allowedPlanIds')) {
    const ids = [...new Set(body.allowedPlanIds || [])];
    if (ids.length && (await db.Plan.count({ where: { id: ids }, transaction })) !== ids.length) {
      errors.push({ field: 'allowedPlanIds', message: 'Every plan must exist' });
    }
    out.allowedPlanIds = ids.length ? ids : null;
  }
  if (has(body, 'allowedCycles')) out.allowedCycles = body.allowedCycles && body.allowedCycles.length ? [...new Set(body.allowedCycles)] : null;
  if (has(body, 'minPriceAmount') || has(body, 'minPriceCurrency')) {
    out.minPriceAmount = body.minPriceAmount == null ? null : body.minPriceAmount;
    out.minPriceCurrency = body.minPriceCurrency == null ? null : body.minPriceCurrency;
    if ((out.minPriceAmount == null) !== (out.minPriceCurrency == null)) {
      errors.push({ field: 'minPriceAmount', message: 'A minimum price needs both an amount and a currency' });
    }
  }
  if (has(body, 'grantType') || has(body, 'grantValue')) {
    out.grantType = body.grantType == null ? null : body.grantType;
    out.grantValue = body.grantValue == null ? null : body.grantValue;
    if ((out.grantType == null) !== (out.grantValue == null)) errors.push({ field: 'grantValue', message: 'A benefit needs both a type and a value' });
    else if (out.grantType && (!Number.isInteger(out.grantValue) || out.grantValue < 1 || out.grantValue > GRANT_LIMITS[out.grantType])) {
      errors.push({ field: 'grantValue', message: `The value is from 1 to ${GRANT_LIMITS[out.grantType]}` });
    }
  }
  if (has(body, 'terms') && body.terms !== null) {
    errors.push(...terms.validateTerms(body.terms));
    if (!errors.length) out.terms = terms.normalizeTerms(body.terms);
  }
  const startsAt = 'startsAt' in out ? out.startsAt : merged.startsAt;
  const endsAt = 'endsAt' in out ? out.endsAt : merged.endsAt;
  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) errors.push({ field: 'endsAt', message: 'The end must be after the start' });
  if (errors.length) throw new ValidationError(errors, 'Invalid body');
  return out;
}

/**
 * A new second-kind code's schedule when the form sends none: its discount
 * on the first payment only, and its commission (its rate or the default)
 * on every payment, on both cycles.
 */
function firstPaymentTerms(fields, commissionRateBp) {
  const discount =
    fields.discountType === 'percentage'
      ? [{ count: 1, type: 'percentage', value: fields.discountValue }]
      : fields.discountType === 'fixed'
        ? [{ count: 1, type: 'fixed', value: fields.discountValue, currency: fields.discountCurrency }]
        : [];
  const commission = [{ count: null, rateBp: commissionRateBp == null ? DEFAULT_COMMISSION_RATE_BP : commissionRateBp }];
  return terms.normalizeTerms({ monthly: { discount, commission }, yearly: { discount, commission } });
}

/**
 * `agentId` null: a code with no agent (second kind only). `own`: an account
 * making its own code, which may hold any role that has the feature; it starts
 * as `approvalStatus` says, switched off until it is approved.
 */
async function createCodeInTransaction(agentId, body, req, transaction, { own = false, approvalStatus = 'approved' } = {}) {
  const v2 = v2Enabled();
  if (!v2 && (agentId == null || V2_FIELDS.some((key) => key !== 'agentId' && has(body, key)))) throw v2Disabled();
  if (agentId != null && !own) await assertAgent(agentId, transaction);

  const code = normalizeCode(body.code);
  if (!CODE_PATTERN.test(code)) {
    throw new ValidationError(
      [{ field: 'code', message: 'A code is 3 to 32 letters, digits or dashes, starting with a letter or digit' }],
      'Invalid body'
    );
  }
  const fields = {
    discountType: body.discountType || 'none',
    discountValue: body.discountValue == null ? null : body.discountValue,
    discountCurrency: body.discountCurrency == null ? null : body.discountCurrency,
  };
  assertDiscount(fields);

  if (await db.ReferralCode.findOne({ where: { code }, attributes: ['id'], transaction })) {
    throw new ConflictError(`The code ${code} is already taken.`, 'REFERRAL_CODE_TAKEN');
  }

  const commissionRateBp = body.commissionRateBp == null ? null : body.commissionRateBp;
  // With the flag on every new code is of the second kind: the discount
  // fields become its first-payment schedule unless it sends its own.
  const second = v2 ? await v2Columns(body, {}, transaction) : {};
  if (v2) {
    if (!second.terms) second.terms = firstPaymentTerms(fields, commissionRateBp);
    if (!('audience' in second)) second.audience = 'new';
  }
  const created = await db.ReferralCode.create(
    {
      agentId,
      code,
      label: body.label ? body.label : null,
      ...(v2 ? { discountType: 'none', discountValue: null, discountCurrency: null, commissionRateBp: null } : { ...fields, commissionRateBp }),
      ...second,
      active: approvalStatus === 'approved' ? (body.active === undefined ? true : body.active) : false,
      approvalStatus,
      createdByUserId: req.user.id,
      updatedByUserId: req.user.id,
    },
    { transaction }
  );
  await auditCode('referral_code.create', req, created, null, auditState(created), transaction);
  return created;
}

async function createCode(agentId, body, req) {
  return db.sequelize.transaction(async (transaction) => {
    try {
      return serializeCode(await createCodeInTransaction(agentId, body, req, transaction));
    } catch (err) {
      throw uniqueViolationToConflict(err, body.code);
    }
  });
}

// Two admins creating the same code at once both pass the pre-check; the
// unique index catches the loser, which should get the same 409.
function uniqueViolationToConflict(err, code) {
  if (err && err.name === 'SequelizeUniqueConstraintError') {
    return new ConflictError(`The code ${normalizeCode(code)} is already taken.`, 'REFERRAL_CODE_TAKEN');
  }
  return err;
}

const EDITABLE = ['label', 'discountType', 'discountValue', 'discountCurrency', 'commissionRateBp', 'active'];

/**
 * What `patch` asks of `code`, checked, as columns. `code` is the code as it
 * stands, or as it would with a change already waiting.
 */
async function columnsFor(code, patch, transaction) {
  const v2 = v2Enabled();
  if (!v2 && V2_FIELDS.some((key) => has(patch, key))) throw v2Disabled();

  const next = {};
  for (const key of EDITABLE) if (key in patch) next[key] = patch[key] === '' ? null : patch[key];
  // Switching the type clears the fields the new type does not take, so a
  // form can send just { discountType: 'none' }.
  if (next.discountType === 'none') {
    if (!('discountValue' in next)) next.discountValue = null;
    if (!('discountCurrency' in next)) next.discountCurrency = null;
  } else if (next.discountType === 'percentage' && !('discountCurrency' in next)) {
    next.discountCurrency = null;
  }
  const merged = {
    discountType: 'discountType' in next ? next.discountType : code.discountType,
    discountValue:
      'discountValue' in next ? next.discountValue : code.discountValue == null ? null : Number(code.discountValue),
    discountCurrency: 'discountCurrency' in next ? next.discountCurrency : code.discountCurrency,
  };
  // A second-kind code's discount lives in its terms; its first-kind fields stay empty.
  if (!code.terms || !['discountType', 'discountValue', 'discountCurrency'].some((key) => key in next)) assertDiscount(merged);
  else throw new ValidationError([{ field: 'discountType', message: "This code's discount is set by its schedule (terms)" }], 'Invalid body');
  const second = v2 ? await v2Columns(patch, code, transaction) : {};
  if (v2 && has(patch, 'agentId')) {
    if (patch.agentId != null) await assertAgent(patch.agentId, transaction);
    second.agentId = patch.agentId;
  }
  // A first-kind code given a schedule keeps its own discount and rate
  // columns, untouched: with the flag off again it prices exactly as before.
  return { ...next, ...second };
}

/** Never approved yet: no store can be using it. */
const neverApproved = (code) => code.approvalStatus !== 'approved' && !code.pendingChanges;

const DATE_COLUMNS = ['startsAt', 'endsAt'];
const AMOUNT_COLUMNS = ['discountValue', 'minPriceAmount', 'grantValue'];
const LIST_COLUMNS = ['allowedPlanIds', 'allowedCycles'];

/** A form sends every field: what matters is what differs, whatever form each side is in. */
function sameValue(key, a, b) {
  const plain = (v) => {
    if (v === undefined || v === null || v === '') return null;
    if (DATE_COLUMNS.includes(key)) return new Date(v).getTime();
    if (AMOUNT_COLUMNS.includes(key)) return Number(v);
    if (LIST_COLUMNS.includes(key)) return v.length ? [...v].sort() : null;
    if (key === 'terms') return terms.normalizeTerms(v);
    return v;
  };
  return JSON.stringify(plain(a)) === JSON.stringify(plain(b));
}

/**
 * The one check on a change to a code, from the console or from /my/*. A
 * creator's applies as it is. From anyone else, the name, the on/off switch and
 * who it belongs to apply at once; anything else that really changes is money
 * (the discount, the commission, the limits, the dates), and
 *   - on a code never approved, goes on the code, which waits for review again;
 *   - on an approved one, waits in pending_changes while the code goes on as
 *     approved, and the code is pending; changing it back clears the wait.
 */
async function applyChange(code, patch, req, transaction) {
  const reviewed = !isCreator(req.user);
  const effective = reviewed ? { ...code.get(), ...(code.pendingChanges || {}) } : code;
  const { label, active, agentId, ...money } = await columnsFor(effective, patch, transaction);
  if (active === true && !code.active && neverApproved(code)) {
    throw new ConflictError('This code has not been approved yet.', 'REFERRAL_CODE_NOT_APPROVED');
  }

  const changed = Object.keys(money).filter((key) => !sameValue(key, money[key], effective[key]));
  const asked = Object.fromEntries(changed.map((key) => [key, money[key]]));
  const fields = { updatedByUserId: req.user.id };
  for (const [key, value] of Object.entries({ label, active, agentId })) {
    if (value !== undefined) fields[key] = value;
  }

  let action = 'referral_code.update';
  if (!reviewed) {
    Object.assign(fields, money);
  } else if (neverApproved(code)) {
    Object.assign(fields, asked);
    if (changed.length) Object.assign(fields, { approvalStatus: 'pending', approvalNote: null });
  } else if (changed.length) {
    const waiting = { ...(code.pendingChanges || {}), ...asked };
    for (const key of Object.keys(waiting)) {
      if (sameValue(key, waiting[key], code.get(key))) delete waiting[key];
    }
    const any = Object.keys(waiting).length > 0;
    Object.assign(fields, {
      pendingChanges: any ? waiting : null,
      approvalStatus: any ? 'pending' : 'approved',
      approvalNote: null,
      changesRejected: false,
    });
    action = 'referral_code.submit_changes';
  }

  const before = auditState(code);
  await code.update(fields, { transaction });
  await auditCode(action, req, code, before, auditState(code), transaction);
  return serializeCode(code);
}

/**
 * Changes a code. The first-kind fields (discount_*, commission_rate_bp)
 * stay editable on a code with no terms, as before. With the flag on, the
 * second-kind fields too, `agentId` included (giving an agentless code an
 * agent, or another one: stores already linked keep their agent). Sending
 * `terms` turns a first-kind code into the second kind: from then on (flag
 * on) its schedule prices every store using it, at each store's own payment
 * number; its first-kind discount and rate stay as they were (read-only),
 * and are what prices it again if the flag is turned off. A code never
 * approved can't be switched on here: that is what approving it does.
 */
async function updateCode(codeId, patch, req) {
  return db.sequelize.transaction(async (transaction) => {
    const code = await db.ReferralCode.findByPk(codeId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!code) throw new NotFoundError('Referral code');
    return applyChange(code, patch, req, transaction);
  });
}

// ------------------------------------------------------------- own codes

/** POST /admin/my/referral-codes: the requester's own code, always theirs whatever the body says. */
async function createOwnCode(body, req) {
  return db.sequelize.transaction(async (transaction) => {
    try {
      const approvalStatus = isCreator(req.user) ? 'approved' : 'pending';
      return serializeCode(await createCodeInTransaction(req.user.id, body, req, transaction, { own: true, approvalStatus }));
    } catch (err) {
      throw uniqueViolationToConflict(err, body.code);
    }
  });
}

/** PATCH /admin/my/referral-codes/:codeId. Someone else's code answers as if it didn't exist. */
async function updateOwnCode(codeId, patch, req) {
  return db.sequelize.transaction(async (transaction) => {
    const code = await db.ReferralCode.findByPk(codeId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!code || code.agentId !== req.user.id) throw new NotFoundError('Referral code');
    return applyChange(code, patch, req, transaction);
  });
}

// -------------------------------------------------------------- the review

async function lockPending(codeId, transaction) {
  const code = await db.ReferralCode.findByPk(codeId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!code) throw new NotFoundError('Referral code');
  if (code.approvalStatus !== 'pending') {
    throw new ConflictError('This code is not waiting for review.', 'REFERRAL_CODE_NOT_PENDING');
  }
  return code;
}

/**
 * POST /admin/referral-codes/:codeId/approve. `edits` is anything the reviewer
 * changed, on top of what was waiting. A code never approved is switched on; a
 * change to an approved one takes effect, and the code stays as on or off as
 * it was.
 */
async function approveCode(codeId, edits, req) {
  return db.sequelize.transaction(async (transaction) => {
    const code = await lockPending(codeId, transaction);
    const waiting = code.pendingChanges || null;
    const columns = await columnsFor({ ...code.get(), ...(waiting || {}) }, edits, transaction);

    const before = auditState(code);
    await code.update(
      {
        ...(waiting || {}),
        ...columns,
        active: waiting ? code.active : true,
        pendingChanges: null,
        approvalStatus: 'approved',
        approvalNote: null,
        changesRejected: false,
        reviewedByUserId: req.user.id,
        reviewedAt: new Date(),
        updatedByUserId: req.user.id,
      },
      { transaction }
    );
    await auditCode('referral_code.approve', req, code, before, auditState(code), transaction);
    return serializeCode(code);
  });
}

/**
 * POST /admin/referral-codes/:codeId/reject. A code never approved stays off;
 * a change to an approved one is dropped, and the code goes on as approved.
 */
async function rejectCode(codeId, { reason }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const code = await lockPending(codeId, transaction);
    const before = auditState(code);
    const changeOnly = Boolean(code.pendingChanges);
    await code.update(
      {
        pendingChanges: null,
        approvalStatus: changeOnly ? 'approved' : 'rejected',
        changesRejected: changeOnly,
        approvalNote: reason || null,
        reviewedByUserId: req.user.id,
        reviewedAt: new Date(),
        updatedByUserId: req.user.id,
      },
      { transaction }
    );
    await auditCode('referral_code.reject', req, code, before, auditState(code), transaction);
    return serializeCode(code);
  });
}

/**
 * The active code a merchant typed, or a 422 that says nothing about whether
 * an inactive code by that name exists.
 */
async function findUsableCode(input, transaction) {
  const code = normalizeCode(input);
  const row = CODE_PATTERN.test(code) ? await db.ReferralCode.findOne({ where: { code }, transaction }) : null;
  if (!row || !canBeEntered(row)) {
    throw new AppError('REFERRAL_CODE_INVALID', "That referral code isn't valid. Check it and try again.", 422);
  }
  return row;
}

module.exports = {
  AUDIENCES,
  GRANT_TYPES,
  GRANT_LIMITS,
  CODE_STATES,
  stateOf,
  v2Enabled,
  DISCOUNT_TYPES,
  CODE_PATTERN,
  normalizeCode,
  serializeCode,
  serializeCodeForMerchant,
  canBeEntered,
  assertDiscount,
  discountFor,
  createCode,
  createCodeInTransaction,
  uniqueViolationToConflict,
  updateCode,
  createOwnCode,
  updateOwnCode,
  approveCode,
  rejectCode,
  findUsableCode,
};
