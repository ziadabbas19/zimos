'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { authIpLimiter } = require('../../core/middleware/rateLimiters');
const invites = require('./inviteAcceptance');

/**
 * The link in an invite email (workspaces/inviteAcceptance.js), mounted at
 * /invites. Reading it needs no account — the page shows the store and the
 * role before the invitee signs in or signs up; accepting needs the signed-in
 * account the invite was sent to. Both count per IP (authIpLimiter). A token
 * of any other shape is an unknown invite (404 INVITE_INVALID), not a 400.
 */

const router = Router();
const tokenParam = { params: Joi.object({ token: Joi.string().max(128).required() }) };

router.get(
  '/:token',
  authIpLimiter,
  validate(tokenParam),
  asyncHandler(async (req, res) => res.json({ invite: await invites.describeInvite(req.params.token) }))
);

router.post(
  '/:token/accept',
  authIpLimiter,
  authenticate,
  validate(tokenParam),
  asyncHandler(async (req, res) => res.json(await invites.acceptInvite(req.params.token, req.user, req)))
);

module.exports = router;
