'use strict';

const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const logger = require('../../core/utils/logger');

/**
 * Geo redirects and funnel settings (SPEC §9.7).
 *
 * Geo redirect: "visitors from [countries] who open this funnel get that
 * funnel instead" — for another currency, language or shipping per country.
 * Everyone else sees the original. The visitor's country comes from the IP
 * intelligence the risk module already uses (risk/visitorGate); an unknown
 * country never redirects.
 *
 * Funnel settings: the funnel's own currency label, icon and search title /
 * description, kept in `funnels.settings`. Pixels, payment methods and
 * shipping per funnel belong to the modules that own those things.
 */

const country = Joi.string().trim().uppercase().length(2);

// --- geo redirects --------------------------------------------------------

const presentRule = (r, names) => ({
  id: r.id,
  sourceFunnelId: r.sourceFunnelId,
  targetFunnelId: r.targetFunnelId,
  targetFunnelName: names ? names.get(r.targetFunnelId) || null : undefined,
  countries: r.countries || [],
  isActive: r.isActive,
});

async function assertFunnel(workspaceId, funnelId, field) {
  const funnel = await db.Funnel.findOne({ where: { id: funnelId, workspaceId }, attributes: ['id', 'name'] });
  if (!funnel) throw new ValidationError([{ field, message: 'That funnel does not belong to this store' }]);
  return funnel;
}

async function listRules(workspaceId, funnelId) {
  const rules = await db.GeoRedirect.findAll({ where: { workspaceId, sourceFunnelId: funnelId }, order: [['createdAt', 'ASC']] });
  const targets = rules.length
    ? await db.Funnel.findAll({ where: { workspaceId, id: rules.map((r) => r.targetFunnelId) }, attributes: ['id', 'name'] })
    : [];
  const names = new Map(targets.map((f) => [f.id, f.name]));
  return rules.map((r) => presentRule(r, names));
}

async function createRule(workspaceId, funnelId, body, req) {
  await assertFunnel(workspaceId, funnelId, 'funnelId');
  if (body.targetFunnelId === funnelId) {
    throw new ValidationError([{ field: 'targetFunnelId', message: 'A funnel cannot redirect to itself' }]);
  }
  await assertFunnel(workspaceId, body.targetFunnelId, 'targetFunnelId');
  const rule = await db.GeoRedirect.create({
    workspaceId,
    sourceFunnelId: funnelId,
    targetFunnelId: body.targetFunnelId,
    countries: [...new Set(body.countries)],
    isActive: body.isActive !== false,
  });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'geo_redirect.create',
    entityType: 'GeoRedirect',
    entityId: rule.id,
    after: presentRule(rule),
    req,
  });
  return presentRule(rule);
}

async function updateRule(workspaceId, funnelId, ruleId, body, req) {
  const rule = await db.GeoRedirect.findOne({ where: { id: ruleId, workspaceId, sourceFunnelId: funnelId } });
  if (!rule) throw new NotFoundError('Geo redirect');
  const before = presentRule(rule);
  const patch = {};
  if (body.targetFunnelId !== undefined) {
    if (body.targetFunnelId === funnelId) {
      throw new ValidationError([{ field: 'targetFunnelId', message: 'A funnel cannot redirect to itself' }]);
    }
    await assertFunnel(workspaceId, body.targetFunnelId, 'targetFunnelId');
    patch.targetFunnelId = body.targetFunnelId;
  }
  if (body.countries !== undefined) patch.countries = [...new Set(body.countries)];
  if (body.isActive !== undefined) patch.isActive = body.isActive;
  await rule.update(patch);
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'geo_redirect.update',
    entityType: 'GeoRedirect',
    entityId: rule.id,
    before,
    after: presentRule(rule),
    req,
  });
  return presentRule(rule);
}

async function deleteRule(workspaceId, funnelId, ruleId, req) {
  const rule = await db.GeoRedirect.findOne({ where: { id: ruleId, workspaceId, sourceFunnelId: funnelId } });
  if (!rule) throw new NotFoundError('Geo redirect');
  await rule.destroy();
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'geo_redirect.delete',
    entityType: 'GeoRedirect',
    entityId: ruleId,
    before: presentRule(rule),
    req,
  });
  return { deleted: true, id: ruleId };
}

/**
 * The funnel a visitor from `countryCode` should get instead of `funnelId`,
 * or null. Only a published target redirects, and only one hop is followed —
 * two funnels pointing at each other cannot loop. Never throws.
 */
async function redirectTarget(workspaceId, funnelId, countryCode) {
  try {
    const code = typeof countryCode === 'string' ? countryCode.trim().toUpperCase() : '';
    if (code.length !== 2) return null;
    const rules = await db.GeoRedirect.findAll({ where: { workspaceId, sourceFunnelId: funnelId, isActive: true } });
    const rule = rules.find((r) => Array.isArray(r.countries) && r.countries.includes(code));
    if (!rule) return null;
    return await db.Funnel.findOne({ where: { id: rule.targetFunnelId, workspaceId, status: 'published' } });
  } catch (err) {
    logger.warn('Geo redirect lookup failed', { error: err.message });
    return null;
  }
}

/** The visitor's country for a public request, or null when it is not known. */
async function countryOf(req) {
  try {
    const visitor = await require('../risk/visitorGate').describeVisitor(req);
    return visitor && visitor.ipCountry ? String(visitor.ipCountry).toUpperCase() : null;
  } catch {
    return null;
  }
}

// --- funnel settings --------------------------------------------------------

// headCode / bodyCode: the funnel's own scripts on every step (SPEC §9.7, storefront FunnelCode);
// shippingProfileId: its shipping group (funnelShipping.js).
const DEFAULT_SETTINGS = Object.freeze({ currency: null, faviconUrl: null, title: null, description: null, headCode: null, bodyCode: null, shippingProfileId: null });
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function resolveSettings(funnel) {
  const s = (funnel && funnel.settings) || {};
  return {
    currency: text(s.currency),
    faviconUrl: text(s.faviconUrl),
    title: text(s.title),
    description: text(s.description),
    headCode: text(s.headCode),
    bodyCode: text(s.bodyCode),
    shippingProfileId: text(s.shippingProfileId),
  };
}

async function getSettings(workspaceId, funnelId) {
  const funnel = await db.Funnel.findOne({ where: { id: funnelId, workspaceId } });
  if (!funnel) throw new NotFoundError('Funnel');
  return resolveSettings(funnel);
}

// The two settings that are scripts. They are not part of what a publish
// freezes: the public funnel reads them off the funnel row, so a new value is
// in front of the shoppers of a live funnel, checkout steps included, as soon
// as it is saved.
const CODE_SETTINGS = ['headCode', 'bodyCode'];

/**
 * `codeRefusal`: why this request may not change the funnel's scripts (the
 * first of funnels.publish, a confirmed account, a store out of draft that it
 * does not meet), or null when it may. Thrown only if the request does change
 * one of them, so the other settings stay where they were: funnels.manage.
 */
async function saveSettings(workspaceId, funnelId, body, req, { codeRefusal = null } = {}) {
  const funnel = await db.Funnel.findOne({ where: { id: funnelId, workspaceId } });
  if (!funnel) throw new NotFoundError('Funnel');
  const before = resolveSettings(funnel);
  // Sent back as it is stored, a script is not a change: a form that saves
  // every field at once still saves the others.
  const changesCode = CODE_SETTINGS.some((key) => body[key] !== undefined && text(body[key]) !== before[key]);
  if (changesCode && codeRefusal) throw codeRefusal;
  if (body.shippingProfileId) {
    const profile = await db.ShippingProfile.findOne({ where: { id: body.shippingProfileId, workspaceId }, attributes: ['id'] });
    if (!profile) throw new NotFoundError('Shipping group');
  }
  const next = { ...DEFAULT_SETTINGS, ...before };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (body[key] !== undefined) next[key] = text(body[key]);
  }
  await funnel.update({ settings: { ...(funnel.settings || {}), ...next } });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'funnel.settings',
    entityType: 'Funnel',
    entityId: funnel.id,
    before,
    after: next,
    req,
  });
  return next;
}

// --- routes ---------------------------------------------------------------

const uuid = Joi.string().uuid();
const funnelParams = Joi.object({ workspaceId: uuid.required(), funnelId: uuid.required() });
const ruleParams = Joi.object({ workspaceId: uuid.required(), funnelId: uuid.required(), ruleId: uuid.required() });
const countries = Joi.array().items(country).min(1).max(60);
const schemas = {
  one: { params: funnelParams },
  createRule: {
    params: funnelParams,
    body: Joi.object({ targetFunnelId: uuid.required(), countries: countries.required(), isActive: Joi.boolean().optional() }),
  },
  updateRule: {
    params: ruleParams,
    body: Joi.object({ targetFunnelId: uuid.optional(), countries: countries.optional(), isActive: Joi.boolean().optional() }).min(1),
  },
  rule: { params: ruleParams },
  settings: {
    params: funnelParams,
    body: Joi.object({
      currency: Joi.string().trim().uppercase().length(3).allow(null, '').optional(),
      faviconUrl: Joi.string().trim().max(1000).uri({ scheme: ['http', 'https'] }).allow(null, '').optional(),
      title: Joi.string().trim().max(200).allow(null, '').optional(),
      description: Joi.string().trim().max(320).allow(null, '').optional(),
      headCode: Joi.string().max(20000).allow(null, '').optional(),
      bodyCode: Joi.string().max(20000).allow(null, '').optional(),
      shippingProfileId: uuid.allow(null, '').optional(),
    }).min(1),
  },
};

/** The first refusal among `guards` for this request, or null when it passes them all. */
async function firstRefusal(guards, req, res) {
  for (const guard of guards) {
    const refusal = await new Promise((resolve) => guard(req, res, (err) => resolve(err || null)));
    if (refusal) return refusal;
  }
  return null;
}

/**
 * Adds the routes to the staff funnels router (see funnelExtras.mount).
 * `LIVE_CONTENT` is what putting a funnel live takes (funnelsRoutes: the
 * publish permission, a confirmed account, a store out of draft); a change to
 * the funnel's scripts takes it too.
 */
function mount(router, { MANAGE, LIVE_CONTENT = [] }) {
  router.get(
    '/:funnelId/geo-redirects',
    validate(schemas.one),
    MANAGE,
    asyncHandler(async (req, res) => res.json({ geoRedirects: await listRules(req.tenant.workspaceId, req.params.funnelId) }))
  );
  router.post(
    '/:funnelId/geo-redirects',
    validate(schemas.createRule),
    MANAGE,
    asyncHandler(async (req, res) =>
      res.status(201).json({ geoRedirect: await createRule(req.tenant.workspaceId, req.params.funnelId, req.body, req) })
    )
  );
  router.patch(
    '/:funnelId/geo-redirects/:ruleId',
    validate(schemas.updateRule),
    MANAGE,
    asyncHandler(async (req, res) =>
      res.json({ geoRedirect: await updateRule(req.tenant.workspaceId, req.params.funnelId, req.params.ruleId, req.body, req) })
    )
  );
  router.delete(
    '/:funnelId/geo-redirects/:ruleId',
    validate(schemas.rule),
    MANAGE,
    asyncHandler(async (req, res) => res.json(await deleteRule(req.tenant.workspaceId, req.params.funnelId, req.params.ruleId, req)))
  );
  router.get(
    '/:funnelId/settings',
    validate(schemas.one),
    MANAGE,
    asyncHandler(async (req, res) => res.json({ settings: await getSettings(req.tenant.workspaceId, req.params.funnelId) }))
  );
  router.patch(
    '/:funnelId/settings',
    validate(schemas.settings),
    MANAGE,
    asyncHandler(async (req, res) => {
      const codeRefusal = await firstRefusal(LIVE_CONTENT, req, res);
      res.json({ settings: await saveSettings(req.tenant.workspaceId, req.params.funnelId, req.body, req, { codeRefusal }) });
    })
  );
}

module.exports = { mount, redirectTarget, countryOf, resolveSettings, saveSettings, CODE_SETTINGS };
