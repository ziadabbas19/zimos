'use strict';

const db = require('../../db/models');
const env = require('../../config/env');
const { discountFor } = require('./referralCodeService');
const terms = require('./referralTerms');

/**
 * What a store's referral code takes off a charge (migration 725). The one
 * place billing asks: subscriptionChargeService (every charge, at pricing and
 * again at payment), merchantPlansService (the plans list), planSwitchService
 * and specialTermsService.
 *
 * The code counts only while it exists and is active, as before. Which rule
 * prices it:
 *   - the terms the store's use of it was entered with (a code of the second
 *     kind: its schedule for the charge's cycle, at the payment's number);
 *   - else, with REFERRAL_CODES_V2_ENABLED, the code's own terms as they stand
 *     now, for a code of the first kind that the console has given a
 *     schedule since (a store that entered it before keeps following it, at
 *     its own payment number);
 *   - else the code's one discount on every charge (the first kind, as before).
 *
 * A payment's number is 1 + the paid charges of that use of the code, so a
 * reversed payment frees its number again.
 */

function v2Enabled() {
  return env.billing.referralCodesV2.enabled === true;
}

const usable = (code) => (code && code.active ? code : null);
const NONE = Object.freeze({ discountAmount: 0, referralCodeId: null, referralRedemptionId: null, referralPaymentNo: null });

async function paidWith(redemptionId, transaction) {
  return db.BillingInvoice.count({ where: { referralRedemptionId: redemptionId, status: 'paid' }, transaction });
}

/** The store's current use of a code (one per subscription). */
function currentRedemption(subscriptionId, transaction) {
  return db.ReferralCodeRedemption.findOne({ where: { subscriptionId, endedAt: null }, transaction });
}

/** The schedule that prices a use of `code`, or null for the first kind's every-charge discount. */
function termsFor(code, redemption) {
  if (redemption && redemption.terms) return redemption.terms;
  if (v2Enabled() && code.terms) return code.terms;
  return null;
}

function discountWith(code, redemption, { cycle, gross, currency, monthlyPrice, paymentNo }) {
  const schedule = termsFor(code, redemption);
  if (!schedule) return discountFor(code, gross, currency);
  return terms.discountAt(terms.forCycle(schedule, cycle).discount, { paymentNo, gross, currency, monthlyPrice });
}

/**
 * The referral part of a new charge of `gross` for `subscription` on `plan`
 * and `cycle`: its discount, code, use and payment number. Spread into the
 * invoice as written.
 */
async function forNewCharge(subscription, plan, { cycle, gross }, transaction) {
  const code = usable(subscription.referralCodeId ? await db.ReferralCode.findByPk(subscription.referralCodeId, { transaction }) : null);
  if (!code) return { ...NONE };
  const red = await currentRedemption(subscription.id, transaction);
  const redemption = red && red.codeId === code.id ? red : null;
  const paymentNo = redemption ? (await paidWith(redemption.id, transaction)) + 1 : null;
  return {
    discountAmount: discountWith(code, redemption, { cycle, gross, currency: plan.currency, monthlyPrice: plan.monthlyPriceAmount, paymentNo }),
    referralCodeId: code.id,
    referralRedemptionId: redemption ? redemption.id : null,
    referralPaymentNo: paymentNo,
  };
}

/**
 * An unpaid charge re-priced at payment: the code it was priced with, as it
 * stands now, at the number this payment would be. `codeLapsed`: it was
 * priced with a code that is no longer usable.
 */
async function forPayment(invoice, { cycle, gross, monthlyPrice }, transaction) {
  const code = usable(invoice.referralCodeId ? await db.ReferralCode.findByPk(invoice.referralCodeId, { transaction }) : null);
  if (!code) return { ...NONE, codeLapsed: Boolean(invoice.referralCodeId) };
  const redemption = invoice.referralRedemptionId ? await db.ReferralCodeRedemption.findByPk(invoice.referralRedemptionId, { transaction }) : null;
  const paymentNo = redemption ? (await paidWith(redemption.id, transaction)) + 1 : null;
  return {
    discountAmount: discountWith(code, redemption, { cycle, gross, currency: invoice.currency, monthlyPrice, paymentNo }),
    referralCodeId: code.id,
    referralRedemptionId: redemption ? redemption.id : null,
    referralPaymentNo: paymentNo,
    codeLapsed: false,
  };
}

/**
 * The use and number a payment at a frozen price belongs to (an online
 * checkout or a transfer proof, priced when the merchant pressed Pay).
 */
async function frozenUse(invoice, referralCodeId, transaction) {
  if (!referralCodeId) return { referralRedemptionId: null, referralPaymentNo: null };
  let redemption = invoice.referralRedemptionId ? await db.ReferralCodeRedemption.findByPk(invoice.referralRedemptionId, { transaction }) : null;
  if (!redemption || redemption.codeId !== referralCodeId) {
    redemption = await db.ReferralCodeRedemption.findOne({ where: { subscriptionId: invoice.subscriptionId, codeId: referralCodeId }, transaction });
  }
  if (!redemption) return { referralRedemptionId: null, referralPaymentNo: null };
  return { referralRedemptionId: redemption.id, referralPaymentNo: (await paidWith(redemption.id, transaction)) + 1 };
}

/**
 * A pricer for the store's NEXT payment, for lists and previews: `(plan,
 * cycle, gross) => discount`. Loads the code and its use once.
 * `classify`: what the plan switch compares plans with: a schedule's
 * discount (which changes from one payment to the next) is left out there,
 * a first-kind code's every-charge discount is not (as before).
 */
async function nextPaymentPricer(subscription, transaction, { classify = false } = {}) {
  const code = usable(subscription.referralCodeId ? await db.ReferralCode.findByPk(subscription.referralCodeId, { transaction }) : null);
  if (!code) return () => 0;
  const red = await currentRedemption(subscription.id, transaction);
  const redemption = red && red.codeId === code.id ? red : null;
  const schedule = termsFor(code, redemption);
  if (!schedule) return (plan, cycle, gross) => discountFor(code, gross, plan.currency);
  if (classify) return () => 0;
  const paymentNo = redemption ? (await paidWith(redemption.id, transaction)) + 1 : 1;
  return (plan, cycle, gross) =>
    terms.discountAt(terms.forCycle(schedule, cycle).discount, { paymentNo, gross, currency: plan.currency, monthlyPrice: plan.monthlyPriceAmount });
}

/**
 * What `code` would take off the first payment of a store entering it now
 * (a preview before it is entered): its own terms, or its one discount.
 */
function firstPaymentDiscount(code, plan, cycle, gross) {
  if (!code.terms) return discountFor(code, gross, plan.currency);
  return terms.discountAt(terms.forCycle(code.terms, cycle).discount, { paymentNo: 1, gross, currency: plan.currency, monthlyPrice: plan.monthlyPriceAmount });
}

/**
 * Whether a store's current use still takes something off a payment to come:
 * a first-kind code with a discount always does; a schedule until its last
 * finite step is paid. A code no longer active takes nothing off.
 */
async function stillDiscounting(code, redemption, transaction) {
  if (!usable(code)) return false;
  const schedule = termsFor(code, redemption);
  if (!schedule) return code.discountType !== 'none';
  const paid = redemption ? await paidWith(redemption.id, transaction) : 0;
  return terms.CYCLES.some((cycle) => {
    const steps = terms.forCycle(schedule, cycle).discount;
    const length = terms.scheduleLength(steps);
    if (length === null) return steps.length > 0;
    return paid < length;
  });
}

module.exports = {
  v2Enabled,
  currentRedemption,
  termsFor,
  forNewCharge,
  forPayment,
  frozenUse,
  nextPaymentPricer,
  firstPaymentDiscount,
  stillDiscounting,
  paidWith,
};
