'use strict';

const { applyBasisPoints } = require('../../core/utils/money');

/**
 * A referral code's schedules (referral_codes.terms, migration 725): what it
 * takes off each payment and what its agent earns on each, separately for
 * monthly and yearly billing. Pure: no database.
 *
 *   terms = {
 *     monthly: { discount: DiscountStep[], commission: CommissionStep[] },
 *     yearly:  { discount: DiscountStep[], commission: CommissionStep[] },
 *   }
 *   DiscountStep   = { count, type: 'percentage', value }   value in basis points, 1..10000
 *                  | { count, type: 'fixed', value, currency }  value in minor units of currency
 *                  | { count, type: 'free_months', value }  value months of the plan's monthly price
 *   CommissionStep = { count, rateBp }                       0..10000
 *
 * Steps run in order. `count` is how many payments a step covers; null (the
 * last step only) means every payment from there on. After the last finite
 * step nothing more is taken off and nothing more is earned. Payment numbers
 * start at 1: the first payment made with the code.
 *
 *   "first payment free, then 20% for 3 payments":
 *     [{ count: 1, type: 'percentage', value: 10000 }, { count: 3, type: 'percentage', value: 2000 }]
 *   "30% on every payment":  [{ count: null, rateBp: 3000 }]
 *
 * A code with NULL terms is of the first kind (legacyTerms): its one discount
 * on every payment and its one commission rate on every payment.
 *
 * An agent link's own schedule (agent_links.terms) is commission steps only:
 * { monthly: CommissionStep[], yearly: CommissionStep[] }.
 *
 * Rounding: every amount is integer minor units; a percentage or a rate is
 * applied with money.applyBasisPoints (half up), once per payment, and a
 * discount never exceeds the price.
 */

const CYCLES = ['monthly', 'yearly'];
const DISCOUNT_STEP_TYPES = ['percentage', 'fixed', 'free_months'];
const COMMISSION_BASES = ['paid', 'list'];
const MAX_STEPS = 12;
const MAX_COUNT = 1200;
const MAX_FREE_MONTHS = 36;
const SIMULATED_PAYMENTS = 12;

/** The step that covers payment `paymentNo` (1-based), or null once the schedule is over. */
function stepAt(steps, paymentNo) {
  let start = 1;
  for (const step of steps || []) {
    if (step.count == null) return step;
    if (paymentNo < start + step.count) return step;
    start += step.count;
  }
  return null;
}

/** How many payments a schedule covers: null for one that never ends. */
function scheduleLength(steps) {
  let total = 0;
  for (const step of steps || []) {
    if (step.count == null) return null;
    total += step.count;
  }
  return total;
}

/**
 * What payment `paymentNo` takes off `gross` (minor units of `currency`).
 * `monthlyPrice` prices a free-months step (months × the plan's monthly
 * price). A fixed amount in another currency takes nothing off: amounts are
 * never converted.
 */
function discountAt(steps, { paymentNo, gross, currency, monthlyPrice = 0 }) {
  const price = Number(gross);
  const step = stepAt(steps, paymentNo);
  if (!step || price <= 0) return 0;
  let discount = 0;
  if (step.type === 'percentage') discount = applyBasisPoints(price, step.value);
  else if (step.type === 'fixed') discount = step.currency === currency ? step.value : 0;
  else if (step.type === 'free_months') discount = step.value * Number(monthlyPrice || 0);
  return Math.max(0, Math.min(discount, price));
}

/** The commission rate for payment `paymentNo`, or null once the schedule is over (nothing is earned). */
function commissionRateAt(steps, paymentNo) {
  const step = stepAt(steps, paymentNo);
  return step ? step.rateBp : null;
}

/** The commission on a payment: `rateBp` of what was paid, or of the list price. */
function commissionOn({ basis, paid, list, rateBp }) {
  const base = basis === 'list' ? Number(list) : Number(paid);
  return { base, commission: applyBasisPoints(Math.max(0, base), rateBp) };
}

/** A code of the first kind (terms NULL) as a schedule: the same discount and rate on every payment. */
function legacyTerms(code, defaultRateBp) {
  const value = code.discountValue == null ? null : Number(code.discountValue);
  const discount =
    code.discountType === 'percentage' && value != null
      ? [{ count: null, type: 'percentage', value }]
      : code.discountType === 'fixed' && value != null
        ? [{ count: null, type: 'fixed', value, currency: code.discountCurrency }]
        : [];
  const commission = [{ count: null, rateBp: code.commissionRateBp == null ? defaultRateBp : code.commissionRateBp }];
  return { monthly: { discount, commission }, yearly: { discount: discount.map((s) => ({ ...s })), commission: commission.map((s) => ({ ...s })) } };
}

function forCycle(terms, cycle) {
  const t = terms && terms[cycle];
  return { discount: (t && t.discount) || [], commission: (t && t.commission) || [] };
}

// ------------------------------------------------------------- validation

const isCount = (n) => n === null || (Number.isInteger(n) && n >= 1 && n <= MAX_COUNT);

function checkSteps(steps, field, checkOne, errors) {
  if (!Array.isArray(steps)) {
    errors.push({ field, message: `${field} must be a list of steps` });
    return;
  }
  if (steps.length > MAX_STEPS) errors.push({ field, message: `${field} has at most ${MAX_STEPS} steps` });
  steps.forEach((step, i) => {
    const at = `${field}[${i}]`;
    if (!step || typeof step !== 'object') {
      errors.push({ field: at, message: 'A step is an object' });
      return;
    }
    if (!isCount(step.count)) errors.push({ field: `${at}.count`, message: `count is a number of payments from 1 to ${MAX_COUNT}, or null for every payment after` });
    else if (step.count === null && i !== steps.length - 1) errors.push({ field: `${at}.count`, message: 'Only the last step can run for every payment after' });
    checkOne(step, at, errors);
  });
}

function checkDiscountStep(step, at, errors) {
  const v = step.value;
  if (!DISCOUNT_STEP_TYPES.includes(step.type)) {
    errors.push({ field: `${at}.type`, message: `type must be one of ${DISCOUNT_STEP_TYPES.join(', ')}` });
  } else if (step.type === 'percentage') {
    if (!Number.isInteger(v) || v < 1 || v > 10000) errors.push({ field: `${at}.value`, message: 'A percentage is in basis points, from 1 (0.01%) to 10000 (100%)' });
  } else if (step.type === 'fixed') {
    if (!Number.isInteger(v) || v < 1) errors.push({ field: `${at}.value`, message: 'A fixed discount is a positive amount in minor units' });
    if (!/^[A-Z]{3}$/.test(step.currency || '')) errors.push({ field: `${at}.currency`, message: 'A fixed discount needs a 3-letter currency code' });
  } else if (!Number.isInteger(v) || v < 1 || v > MAX_FREE_MONTHS) {
    errors.push({ field: `${at}.value`, message: `Free months are from 1 to ${MAX_FREE_MONTHS}` });
  }
}

function checkCommissionStep(step, at, errors) {
  if (!Number.isInteger(step.rateBp) || step.rateBp < 0 || step.rateBp > 10000) {
    errors.push({ field: `${at}.rateBp`, message: 'A rate is in basis points, from 0 to 10000 (100%)' });
  }
}

/** Field errors for a code's terms ([] when they are good). */
function validateTerms(terms, field = 'terms') {
  const errors = [];
  if (!terms || typeof terms !== 'object') return [{ field, message: 'terms must set monthly and yearly' }];
  for (const cycle of CYCLES) {
    const t = terms[cycle];
    if (!t || typeof t !== 'object') {
      errors.push({ field: `${field}.${cycle}`, message: `terms.${cycle} is required` });
      continue;
    }
    checkSteps(t.discount || [], `${field}.${cycle}.discount`, checkDiscountStep, errors);
    checkSteps(t.commission || [], `${field}.${cycle}.commission`, checkCommissionStep, errors);
  }
  return errors;
}

/** Field errors for an agent link's commission schedule. */
function validateLinkTerms(terms, field = 'terms') {
  const errors = [];
  if (!terms || typeof terms !== 'object') return [{ field, message: 'terms must set monthly and yearly' }];
  for (const cycle of CYCLES) checkSteps(terms[cycle], `${field}.${cycle}`, checkCommissionStep, errors);
  return errors;
}

const cleanDiscount = (s) => ({
  count: s.count,
  type: s.type,
  value: s.value,
  ...(s.type === 'fixed' ? { currency: s.currency } : {}),
});
const cleanCommission = (s) => ({ count: s.count, rateBp: s.rateBp });

/** The stored form of good terms: only the known keys, in order. */
function normalizeTerms(terms) {
  const out = {};
  for (const cycle of CYCLES) {
    const t = terms[cycle] || {};
    out[cycle] = { discount: (t.discount || []).map(cleanDiscount), commission: (t.commission || []).map(cleanCommission) };
  }
  return out;
}

function normalizeLinkTerms(terms) {
  const out = {};
  for (const cycle of CYCLES) out[cycle] = (terms[cycle] || []).map(cleanCommission);
  return out;
}

// -------------------------------------------------------------- simulator

/**
 * The first `payments` payments of one plan on one cycle under `terms`:
 * list price, discount, what the merchant pays, the agent's commission (none
 * without an agent) and what the platform keeps. `gross` is one period's
 * list price, `monthlyPrice` the plan's monthly price (free months).
 */
function simulate({ terms, cycle, gross, monthlyPrice, currency, commissionBasis = 'paid', hasAgent = true, commissionSteps = null, payments = SIMULATED_PAYMENTS }) {
  const t = forCycle(terms, cycle);
  const steps = commissionSteps || t.commission;
  const rows = [];
  const totals = { listPrice: 0, discount: 0, merchantPays: 0, commission: 0, platformNet: 0 };
  for (let n = 1; n <= payments; n += 1) {
    const discount = discountAt(t.discount, { paymentNo: n, gross, currency, monthlyPrice });
    const merchantPays = Number(gross) - discount;
    const rateBp = hasAgent ? commissionRateAt(steps, n) : null;
    const commission = rateBp == null ? 0 : commissionOn({ basis: commissionBasis, paid: merchantPays, list: gross, rateBp }).commission;
    const row = { paymentNo: n, listPrice: Number(gross), discount, merchantPays, commissionRateBp: rateBp, commission, platformNet: merchantPays - commission };
    rows.push(row);
    for (const key of Object.keys(totals)) totals[key] += row[key];
  }
  return { cycle, currency, commissionBasis, rows, totals };
}

module.exports = {
  CYCLES,
  DISCOUNT_STEP_TYPES,
  COMMISSION_BASES,
  MAX_STEPS,
  MAX_COUNT,
  MAX_FREE_MONTHS,
  SIMULATED_PAYMENTS,
  stepAt,
  scheduleLength,
  discountAt,
  commissionRateAt,
  commissionOn,
  legacyTerms,
  forCycle,
  validateTerms,
  validateLinkTerms,
  normalizeTerms,
  normalizeLinkTerms,
  simulate,
};
