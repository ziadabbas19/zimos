'use strict';

const Joi = require('joi');
const { BILLING_CYCLES } = require('./planPricing');

const METHOD_CODE = /^[a-z][a-z0-9_]{1,39}$/;

module.exports = {
  METHOD_CODE,
  // The code's own format is checked by referralCodeService, which answers
  // any unusable code with the same REFERRAL_CODE_INVALID.
  attachReferralCode: { body: Joi.object({ code: Joi.string().trim().min(1).max(64).required() }) },
  // Monthly or annual (10 × monthly); applies from the next charge.
  setBillingCycle: { body: Joi.object({ billingCycle: Joi.string().valid(...BILLING_CYCLES).required() }) },
  // The Pay button. Takes no amount: the server prices the charge. `method`
  // names an offered gateway (payment_methods); without it, Fawaterak.
  startOnlinePayment: {
    body: Joi.object({
      lang: Joi.string().valid('ar', 'en').default('ar'),
      method: Joi.string().pattern(METHOD_CODE).optional(),
    }),
  },
  // A transfer's proof, multipart: the screenshot is the `file` part. No
  // amount: the server takes the charge's. The charge is a pending one by its
  // id, or `next` (paymentProofService.NEXT_CHARGE): written with the proof.
  // `expectedAmount` is the amount the merchant was shown, in minor units,
  // only compared with the server's (409 CHARGE_AMOUNT_CHANGED).
  submitInvoiceProof: {
    params: Joi.object({
      workspaceId: Joi.string().required(),
      invoiceId: Joi.alternatives(Joi.string().guid(), Joi.string().valid('next')).required(),
    }),
    body: Joi.object({
      methodCode: Joi.string().pattern(METHOD_CODE).required(),
      senderPhone: Joi.string().trim().min(6).max(32).required(),
      expectedAmount: Joi.number().integer().min(0).max(1e12).optional(),
    }),
  },
  getOnlinePayment: {
    params: Joi.object({ workspaceId: Joi.string().required(), paymentId: Joi.string().guid().required() }),
  },
  // What a referral code would take off each plan, before it is attached.
  previewCode: { body: Joi.object({ code: Joi.string().trim().min(1).max(64).required() }) },
  listInvoices: {
    query: Joi.object({
      page: Joi.number().integer().min(1).max(10000).default(1),
      pageSize: Joi.number().integer().min(1).max(50).default(20),
    }),
  },
  // Another plan on offer, at once, while nothing is paid. No price: the server prices it.
  changePlan: {
    body: Joi.object({
      planId: Joi.string().guid().required(),
      billingCycle: Joi.string().valid(...BILLING_CYCLES).optional(),
    }),
  },
  // A merchant changing plan by themselves (planSwitchService). Without
  // `billingCycle`, the subscription's. `expectedAmount` (start only) is what
  // the preview showed as due now, in minor units, only compared with the
  // server's (409 SWITCH_AMOUNT_CHANGED).
  previewPlanSwitch: {
    body: Joi.object({
      planId: Joi.string().guid().required(),
      billingCycle: Joi.string().valid(...BILLING_CYCLES).optional(),
    }),
  },
  startPlanSwitch: {
    body: Joi.object({
      planId: Joi.string().guid().required(),
      billingCycle: Joi.string().valid(...BILLING_CYCLES).optional(),
      expectedAmount: Joi.number().integer().min(0).max(1e12).optional(),
    }),
  },
  // A pay-per-order store moving to a plan on offer (merchantPlansService.requestPlanMove).
  requestPlanMove: {
    body: Joi.object({
      planId: Joi.string().guid().required(),
      billingCycle: Joi.string().valid(...BILLING_CYCLES).default('monthly'),
    }),
  },

  // A top-up transfer, multipart: the amount the merchant sent, minor units
  // (the limits are walletService's), the method, the sender and the `file`.
  submitTopup: {
    body: Joi.object({
      requestedAmount: Joi.number().integer().min(1).max(1e12).required(),
      methodCode: Joi.string().pattern(METHOD_CODE).required(),
      senderPhone: Joi.string().trim().min(6).max(32).required(),
    }),
  },
  // A card top-up: the amount in minor units (the limits are walletService's),
  // the gateway (a payment_methods code; Fawaterak when left out) and the
  // checkout's language.
  startOnlineTopup: {
    body: Joi.object({
      amount: Joi.number().integer().min(1).max(1e12).required(),
      method: Joi.string().pattern(METHOD_CODE).optional(),
      lang: Joi.string().valid('ar', 'en').default('ar'),
    }),
  },
  // A refund of the prepaid balance (billing/walletRefundService): the amount
  // in minor units (the limits are the service's), where to send it, and the
  // dialog's own id so a retry is one request.
  requestWalletRefund: {
    body: Joi.object({
      amount: Joi.number().integer().min(1).max(1e12).required(),
      payoutMethod: Joi.string().trim().max(30).allow('', null).optional(),
      payoutAccount: Joi.string().trim().max(120).allow('', null).optional(),
      requestId: Joi.string().guid().optional(),
    }),
  },
  walletRefundParams: {
    params: Joi.object({ workspaceId: Joi.string().required(), refundId: Joi.string().guid().required() }),
  },
  adminListWalletRefunds: {
    query: Joi.object({
      status: Joi.string().valid('requested', 'approved', 'rejected', 'cancelled', 'paid').optional(),
      page: Joi.number().integer().min(1).max(10000).default(1),
      pageSize: Joi.number().integer().min(1).max(50).default(20),
    }),
  },
  adminApproveWalletRefund: {
    params: Joi.object({ refundId: Joi.string().guid().required() }),
    body: Joi.object({ note: Joi.string().trim().max(500).allow('', null).optional() }),
  },
  adminRejectWalletRefund: {
    params: Joi.object({ refundId: Joi.string().guid().required() }),
    body: Joi.object({ note: Joi.string().trim().min(3).max(500).required() }),
  },
  adminMarkWalletRefundPaid: {
    params: Joi.object({ refundId: Joi.string().guid().required() }),
    body: Joi.object({
      payoutReference: Joi.string().trim().min(2).max(200).required(),
      note: Joi.string().trim().max(500).allow('', null).optional(),
    }),
  },
  walletLedger: {
    query: Joi.object({
      page: Joi.number().integer().min(1).max(10000).default(1),
      pageSize: Joi.number().integer().min(1).max(50).default(20),
    }),
  },
  adminWorkspaceWallet: {
    params: Joi.object({ workspaceId: Joi.string().guid().required() }),
    query: Joi.object({
      page: Joi.number().integer().min(1).max(10000).default(1),
      pageSize: Joi.number().integer().min(1).max(50).default(20),
    }),
  },
  // The console's own wallet entries (walletService.grantFreeOrders,
  // adjustBalance): always a reason, and the dialog's own requestId so a
  // retry writes nothing twice. The limits match walletService.
  adminGrantFreeOrders: {
    params: Joi.object({ workspaceId: Joi.string().guid().required() }),
    body: Joi.object({
      count: Joi.number().integer().min(1).max(1000).required(),
      reason: Joi.string().trim().min(3).max(500).required(),
      requestId: Joi.string().guid().required(),
    }),
  },
  adminAdjustWallet: {
    params: Joi.object({ workspaceId: Joi.string().guid().required() }),
    body: Joi.object({
      amount: Joi.number().integer().min(-2000000).max(2000000).invalid(0).required(),
      reason: Joi.string().trim().min(3).max(500).required(),
      requestId: Joi.string().guid().required(),
      // correction (either way, as before) or gift (adds only); never refundable.
      kind: Joi.string().valid('correction', 'gift').default('correction'),
      notifyMerchant: Joi.boolean().default(false),
    }),
  },

  // --- the console: payment methods and proofs
  adminUpdatePaymentMethod: {
    params: Joi.object({ code: Joi.string().pattern(METHOD_CODE).required() }),
    body: Joi.object({
      enabled: Joi.boolean(),
      labelAr: Joi.string().trim().min(1).max(80),
      labelEn: Joi.string().trim().min(1).max(80),
    }).min(1),
  },
  adminReorderPaymentMethods: {
    body: Joi.object({ codes: Joi.array().items(Joi.string().pattern(METHOD_CODE)).min(1).max(50).unique().required() }),
  },
  adminUpdatePaymentMethodAccount: {
    params: Joi.object({ code: Joi.string().pattern(METHOD_CODE).required() }),
    body: Joi.object({
      accountNumber: Joi.string().trim().max(80).allow(''),
      // Optional: empty or null clears it; a given link must be https.
      paymentLink: Joi.string().trim().max(500).uri({ scheme: ['https'] }).allow('', null),
      noteAr: Joi.string().trim().max(500).allow(''),
      noteEn: Joi.string().trim().max(500).allow(''),
    }).min(1),
  },
  adminListProofs: {
    query: Joi.object({
      status: Joi.string().valid('pending', 'approved', 'rejected', 'all').default('pending'),
      page: Joi.number().integer().min(1).max(10000).default(1),
      pageSize: Joi.number().integer().min(1).max(50).default(20),
    }),
  },
  adminProofParams: { params: Joi.object({ proofId: Joi.string().guid().required() }) },
  // The amount that arrived, in minor units.
  adminApproveProof: {
    params: Joi.object({ proofId: Joi.string().guid().required() }),
    body: Joi.object({ receivedAmount: Joi.number().integer().min(0).max(1e12).required() }),
  },
  // The note is required, and the merchant reads it.
  adminRejectProof: {
    params: Joi.object({ proofId: Joi.string().guid().required() }),
    body: Joi.object({ note: Joi.string().trim().min(3).max(1000).required() }),
  },
};
