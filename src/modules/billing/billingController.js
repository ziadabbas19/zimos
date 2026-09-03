'use strict';

const asyncHandler = require('express-async-handler');
const { AppError } = require('../../core/errors/AppError');
const service = require('./billingService');
const { verifyGatewaySignature } = require('./gatewaySignature');

// POST /api/v1/billing/webhook  — no auth; identity comes from the signature.
const webhook = asyncHandler(async (req, res) => {
  if (!verifyGatewaySignature(req.body, req.headers)) {
    throw new AppError('INVALID_SIGNATURE', 'Webhook signature verification failed', 400);
  }
  const result = await service.applyWebhookEvent(req.body);
  // Always 200 for a well-formed request so the gateway doesn't retry storms;
  // `handled: false` tells us it was a no-op.
  res.json({ received: true, ...result });
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

module.exports = { webhook, runTrialCheck, adminWorkspaces, adminDashboard };
