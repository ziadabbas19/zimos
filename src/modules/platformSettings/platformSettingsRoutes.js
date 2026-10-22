'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const env = require('../../config/env');
const validate = require('../../core/middleware/validate');
const { notFoundHandler } = require('../../core/middleware/errorHandler');
const { createIpMinuteLimiter } = require('../../core/middleware/rateLimiters');
const { requirePlatformPermission: can } = require('../../core/middleware/platformAdminGuard');
const { PLATFORM_PERMISSIONS: P } = require('../../core/security/platformPermissions');
const { AppError, ValidationError } = require('../../core/errors/AppError');
const service = require('./platformSettingsService');
const { GROUPS, findSecrets, validateGroup } = require('./rules');

// ---- Public: GET /api/v1/platform-settings/public ---------------------------
// No sign-in: the marketing site reads it on its server, the dashboard from the
// browser. The saved public groups only (contact, social, company, footer),
// `null` for a group never saved. Off (PLATFORM_SETTINGS_ENABLED) it answers
// 404 like an unknown path, and the sites show the values in their code.
const publicRouter = Router();
const publicLimiter = createIpMinuteLimiter('platform-settings', 120, { skip: () => env.isTest });

publicRouter.get(
  '/public',
  (req, res, next) => (env.platformSettings.enabled ? next() : notFoundHandler(req, res, next)),
  publicLimiter,
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json(await service.publicSettings());
  })
);

// ---- Console: /api/v1/admin/platform-settings ---------------------------------
// Mounted under the console's router (after its authenticate). Reading needs
// platform_settings.view, every write platform_settings.manage; both work with
// the flag off, so the values can be ready before it is turned on.
const adminRouter = Router();

const groupParams = Joi.object({ group: Joi.string().valid(...GROUPS).required() });
const schemas = {
  group: { params: groupParams },
  history: { params: groupParams, query: Joi.object({ limit: Joi.number().integer().min(1).max(100).default(30) }) },
  revert: { params: groupParams, body: Joi.object({ auditId: Joi.string().guid().required() }).required() },
};

/**
 * The group's body: refused outright when any field looks like a secret (by
 * its name or its value), then checked field by field against the group's
 * schema (rules.js), which names every field it keeps.
 */
function groupBody(req, res, next) {
  const secrets = findSecrets(req.body);
  if (secrets.length > 0) {
    return next(new AppError('SECRET_NOT_ALLOWED', 'Platform settings never hold a secret, a key or a password', 422, secrets));
  }
  const { error, value } = validateGroup(req.params.group, req.body);
  if (error) {
    return next(new ValidationError(error.details.map((d) => ({ field: d.path.join('.'), message: d.message })), 'Invalid body'));
  }
  req.body = value;
  next();
}

adminRouter.get(
  '/platform-settings',
  can(P.PLATFORM_SETTINGS_VIEW),
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await service.adminState());
  })
);

adminRouter.get(
  '/platform-settings/:group/history',
  can(P.PLATFORM_SETTINGS_VIEW),
  validate(schemas.history),
  asyncHandler(async (req, res) => res.json(await service.history(req.params.group, { limit: req.query.limit })))
);

adminRouter.put(
  '/platform-settings/:group',
  can(P.PLATFORM_SETTINGS_MANAGE),
  validate(schemas.group),
  groupBody,
  asyncHandler(async (req, res) => res.json(await service.saveGroup(req.params.group, req.body, req)))
);

adminRouter.post(
  '/platform-settings/:group/reset',
  can(P.PLATFORM_SETTINGS_MANAGE),
  validate(schemas.group),
  asyncHandler(async (req, res) => res.json(await service.resetGroup(req.params.group, req)))
);

adminRouter.post(
  '/platform-settings/:group/revert',
  can(P.PLATFORM_SETTINGS_MANAGE),
  validate(schemas.revert),
  asyncHandler(async (req, res) => res.json(await service.revert(req.params.group, req.body.auditId, req)))
);

module.exports = { publicRouter, adminRouter };
