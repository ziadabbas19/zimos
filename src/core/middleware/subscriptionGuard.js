'use strict';

const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const { AppError } = require('../errors/AppError');

const ALLOWED = new Set(['trialing', 'active']);

/**
 * Blocks workspace-mutating actions when the subscription is not trialing or
 * active. Never applied to public storefront routes — a lapsed bill must not
 * break a live store. Runs after `resolveTenant`.
 */
const requireActiveSubscription = asyncHandler(async (req, res, next) => {
  const sub = await db.Subscription.findOne({
    where: { workspaceId: req.tenant.workspaceId },
    attributes: ['status'],
  });
  if (!sub || !ALLOWED.has(sub.status)) {
    throw new AppError(
      'SUBSCRIPTION_REQUIRED',
      'This workspace needs an active subscription to make changes',
      402
    );
  }
  next();
});

module.exports = { requireActiveSubscription };
