'use strict';

const asyncHandler = require('express-async-handler');
const { AppError } = require('../../core/errors/AppError');
const service = require('./billingService');
const { verifyGatewaySignature } = require('./gatewaySignature');
const onlineBilling = require('./onlineBillingService');
const merchantPlans = require('./merchantPlansService');
const planSwitches = require('./planSwitchService');

// POST /api/v1/billing/webhook  — no auth; identity comes from the signature.
// Verified against req.rawBody (the exact bytes the gateway signed), never the
// parsed body. A request that fails is unauthenticated, hence 401.
const webhook = asyncHandler(async (req, res) => {
  if (!verifyGatewaySignature(req.rawBody, req.headers)) {
    throw new AppError('INVALID_SIGNATURE', 'Webhook signature verification failed', 401);
  }
  const result = await service.applyWebhookEvent(req.body);
  // Always 200 for a well-formed request so the gateway doesn't retry storms;
  // `handled: false` tells us it was a no-op.
  res.json({ received: true, ...result });
});

// POST /api/v1/billing/fawaterak/:token/:route  — Fawaterak's webhooks
// (paid_json, failed_json, cancel, refund). No auth: the path token and the
// signature are checked before anything is written. A webhook only prompts
// a getTransactionData check (billing/onlineBillingService).
const fawaterakWebhook = asyncHandler(async (req, res) => {
  const { status } = await onlineBilling.receiveWebhook(req.params.route, req.params.token, req.body);
  if (status === 404) throw new AppError('NOT_FOUND', 'Not found', 404);
  if (status === 401) throw new AppError('INVALID_SIGNATURE', 'Webhook signature verification failed', 401);
  res.json({ status: 'ok' });
});

// POST /api/v1/billing/run-trial-check  — platform admin (manual for now).
const runTrialCheck = asyncHandler(async (req, res) => {
  res.json(await service.expireStaleTrials());
});

// GET /api/v1/admin/workspaces  — platform admin, JSON.
const adminWorkspaces = asyncHandler(async (req, res) => {
  res.json({ workspaces: await service.listWorkspacesOverview() });
});

// GET /api/v1/admin/dashboard  — platform admin, HTML table.
const adminDashboard = asyncHandler(async (req, res) => {
  res.removeHeader('Content-Security-Policy');
  res.render('admin-dashboard', {
    title: 'Platform admin',
    rows: await service.listWorkspacesOverview(),
  });
});

// GET /api/v1/workspaces/:workspaceId/billing  — the merchant's own summary.
const getWorkspaceBilling = asyncHandler(async (req, res) => {
  res.json({ billing: await service.getWorkspaceBilling(req.tenant.workspaceId) });
});

// POST /api/v1/workspaces/:workspaceId/billing/referral-code
// 201 when the code was attached; 200 when it already was.
const attachReferralCode = asyncHandler(async (req, res) => {
  const { billing, attached } = await service.attachReferralCode(req.tenant.workspaceId, req.body.code, req, {
    planId: req.body.planId || null,
    billingCycle: req.body.billingCycle || null,
  });
  res.status(attached ? 201 : 200).json({ billing, attached });
});

// PATCH /api/v1/workspaces/:workspaceId/billing  — monthly or annual, from the
// next charge. 409 OPEN_CHARGE_EXISTS while a charge is open.
const setBillingCycle = asyncHandler(async (req, res) => {
  const { changed } = await service.setBillingCycle(req.tenant.workspaceId, req.body.billingCycle, req);
  res.json({ billing: await service.getWorkspaceBilling(req.tenant.workspaceId), changed });
});

// POST /api/v1/workspaces/:workspaceId/billing/payments  — the Pay button.
// 201 with a new checkout; 200 when a second press gets the same one back.
const startOnlinePayment = asyncHandler(async (req, res) => {
  const { payment, reused } = await onlineBilling.startPayment(req.tenant.workspaceId, req.body, req);
  res.status(reused ? 200 : 201).json({ payment, reused });
});

// GET /api/v1/workspaces/:workspaceId/billing/payments/:paymentId  — where
// Fawaterak sends the merchant back; asks Fawaterak while it is in progress.
const getOnlinePayment = asyncHandler(async (req, res) => {
  res.json(await onlineBilling.getPayment(req.tenant.workspaceId, req.params.paymentId));
});

// The Subscription section (billing/merchantPlansService).
const listPlans = asyncHandler(async (req, res) => {
  res.json(await merchantPlans.listPlans(req.tenant.workspaceId));
});

const previewCode = asyncHandler(async (req, res) => {
  res.json(
    await merchantPlans.previewCode(req.tenant.workspaceId, req.body.code, { planId: req.body.planId || null, billingCycle: req.body.billingCycle || null })
  );
});

const listInvoices = asyncHandler(async (req, res) => {
  res.json(await merchantPlans.listInvoices(req.tenant.workspaceId, req.query));
});

const changePlan = asyncHandler(async (req, res) => {
  res.json(await merchantPlans.changePlan(req.tenant.workspaceId, req.body, req));
});

// POST /api/v1/workspaces/:workspaceId/billing/plan-move/cancel — the move waiting for its payment is dropped.
const cancelPlanMove = asyncHandler(async (req, res) => {
  res.json(await merchantPlans.cancelPlanMove(req.tenant.workspaceId, req));
});

// POST /api/v1/workspaces/:workspaceId/billing/plan-move — pay per order → a plan, switched when its charge is paid.
const requestPlanMove = asyncHandler(async (req, res) => {
  const result = await merchantPlans.requestPlanMove(req.tenant.workspaceId, req.body, req);
  res.status(result.created ? 201 : 200).json(result);
});

// POST /api/v1/workspaces/:workspaceId/billing/plan-switch/preview — what changing to a plan would do; writes nothing.
const previewPlanSwitch = asyncHandler(async (req, res) => {
  res.json(await planSwitches.preview(req.tenant.workspaceId, req.body));
});

// POST /api/v1/workspaces/:workspaceId/billing/plan-switch — 201 with a new switch, 200 otherwise.
const startPlanSwitch = asyncHandler(async (req, res) => {
  const result = await planSwitches.start(req.tenant.workspaceId, req.body, req);
  res.status(result.created ? 201 : 200).json(result);
});

// POST /api/v1/workspaces/:workspaceId/billing/plan-switch/cancel — the switch waiting is dropped.
const cancelPlanSwitch = asyncHandler(async (req, res) => {
  res.json(await planSwitches.cancel(req.tenant.workspaceId, req));
});

// POST /api/v1/workspaces/:workspaceId/billing/charges/:chargeId/cancel — a pending charge voided by the merchant.
const cancelCharge = asyncHandler(async (req, res) => {
  res.json(await planSwitches.cancelCharge(req.tenant.workspaceId, req.params.chargeId, req));
});

module.exports = {
  cancelCharge,
  previewPlanSwitch,
  startPlanSwitch,
  cancelPlanSwitch,
  requestPlanMove,
  cancelPlanMove,
  listPlans,
  previewCode,
  listInvoices,
  changePlan,
  webhook,
  fawaterakWebhook,
  startOnlinePayment,
  getOnlinePayment,
  runTrialCheck,
  adminWorkspaces,
  adminDashboard,
  getWorkspaceBilling,
  attachReferralCode,
  setBillingCycle,
};
