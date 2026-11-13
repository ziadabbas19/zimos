'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { NotFoundError } = require('../../core/errors/AppError');
const { emailCampaignLimiters: limit, emailSignupLimiters: signupLimit } = require('../../core/middleware/rateLimiters');
const { requireGrowthFeature } = require('../billing/growthFeatures');
const service = require('./campaignService');
const unsubscribe = require('./campaignUnsubscribe');
const tokens = require('./campaignTokens');
const { schemas } = require('./campaignValidation');
const signup = require('./signupService');
const signupSettings = require('./signupSettings');

/*
 * Email campaigns (EMAIL_CAMPAIGNS_ENABLED; off, every route here answers 404).
 *
 * Staff, /api/v1/workspaces/:workspaceId/email-campaigns — discounts.manage
 * (the marketing permission the coupons and cart rewards use), and with
 * GROWTH_REQUIRE_PLAN_FEATURE the plan's `email_campaigns`:
 *   GET    /overview                 quota, sender, provider, language, segments
 *   GET    /products?q=              the store's products for a products block
 *   POST   /audience                 { audience } → { count, subscribed }
 *   POST   /preview                  the draft rendered: { subject, html, text }
 *   POST   /test                     the draft to the teammate's own address
 *   GET    /                         campaigns, newest first (?status, ?cursor)
 *   POST   /                         a new draft
 *   GET    /:campaignId              one campaign with its numbers
 *   PATCH  /:campaignId              edit a draft or scheduled campaign
 *   DELETE /:campaignId              a draft, scheduled, failed or cancelled one
 *   POST   /:campaignId/send         start now (quota checked, refused whole)
 *   POST   /:campaignId/schedule     { scheduledAt }
 *   POST   /:campaignId/unschedule   back to a draft
 *   POST   /:campaignId/cancel       stop a scheduled or sending campaign
 *   GET    /:campaignId/recipients   who it went to, and what happened (?status)
 *   GET    /signup                   where shoppers sign up: the settings, the
 *                                    subscribers by source (signupService.js)
 *   PUT    /signup                   the settings, whole (signupSettings.js)
 *
 * Public, no sign-in, /api/v1/email-campaigns/unsubscribe?t=<token>:
 *   POST  the one-click unsubscribe mail apps make from the List-Unsubscribe
 *         header (RFC 8058); GET sends a person to the store's own page.
 * The store's page itself posts to /store/:id/marketing/unsubscribe
 * (notifications/marketingUnsubscribe.js), which reads these tokens too.
 *
 * Public, /api/v1/store/:workspaceId/email-signup (the `store` router, inside
 * the public store routes): the footer and popup signup, { email, source,
 * website }. Limited per address and per store; 404 while off, for a place
 * switched off, or a plan without campaigns.
 */

const gate = (req, res, next) => (service.flagOn() ? next() : next(new NotFoundError('Email campaigns')));
const ws = (req) => req.tenant.workspaceId;
const id = (req) => req.params.campaignId;

const staff = Router({ mergeParams: true });
staff.use(gate, authenticate, resolveTenant, requirePermission(PERMISSIONS.DISCOUNTS_MANAGE), requireGrowthFeature('email_campaigns'));

staff.get('/overview', validate(schemas.plain), asyncHandler(async (req, res) => res.json(await service.overview(ws(req)))));
staff.get(
  '/products',
  validate({ ...schemas.plain, query: Joi.object({ q: Joi.string().trim().max(100).allow(''), limit: Joi.number().integer().min(1).max(50).default(20) }) }),
  asyncHandler(async (req, res) => res.json({ products: await service.products(ws(req), req.query) }))
);
staff.post('/audience', limit.writes, validate(schemas.audience), asyncHandler(async (req, res) => res.json(await service.previewAudience(ws(req), req.body.audience))));
staff.post('/preview', limit.writes, validate(schemas.preview), asyncHandler(async (req, res) => res.json({ preview: await service.preview(ws(req), req.body) })));
staff.post('/test', limit.tests, validate(schemas.test), asyncHandler(async (req, res) => res.json(await service.sendTest(ws(req), req.body, req))));

// Before '/:campaignId', so "signup" is never read as a campaign id.
staff.get('/signup', validate(schemas.plain), asyncHandler(async (req, res) => res.json(await signup.view(ws(req)))));
staff.put(
  '/signup',
  limit.writes,
  validate({ ...schemas.plain, body: signupSettings.schema }),
  asyncHandler(async (req, res) => {
    await signupSettings.save(ws(req), req.body, req);
    res.json(await signup.view(ws(req)));
  })
);

staff.get('/', validate(schemas.list), asyncHandler(async (req, res) => res.json(await service.list(ws(req), req.query))));
staff.post('/', limit.writes, validate(schemas.create), asyncHandler(async (req, res) => res.status(201).json({ campaign: await service.create(ws(req), req.body, req) })));
staff.get('/:campaignId', validate(schemas.one), asyncHandler(async (req, res) => res.json({ campaign: await service.get(ws(req), id(req)) })));
staff.patch('/:campaignId', limit.writes, validate(schemas.update), asyncHandler(async (req, res) => res.json({ campaign: await service.update(ws(req), id(req), req.body, req) })));
staff.delete('/:campaignId', limit.writes, validate(schemas.one), asyncHandler(async (req, res) => res.json(await service.remove(ws(req), id(req), req))));
staff.post('/:campaignId/send', limit.writes, validate(schemas.one), asyncHandler(async (req, res) => res.json({ campaign: await service.sendNow(ws(req), id(req), req) })));
staff.post(
  '/:campaignId/schedule',
  limit.writes,
  validate(schemas.schedule),
  asyncHandler(async (req, res) => res.json({ campaign: await service.schedule(ws(req), id(req), req.body.scheduledAt, req) }))
);
staff.post('/:campaignId/unschedule', limit.writes, validate(schemas.one), asyncHandler(async (req, res) => res.json({ campaign: await service.unschedule(ws(req), id(req), req) })));
staff.post('/:campaignId/cancel', limit.writes, validate(schemas.one), asyncHandler(async (req, res) => res.json({ campaign: await service.cancel(ws(req), id(req), req) })));
staff.get('/:campaignId/recipients', validate(schemas.recipients), asyncHandler(async (req, res) => res.json(await service.recipients(ws(req), id(req), req.query))));

const pub = Router();
pub.use(gate);
pub.post(
  '/unsubscribe',
  limit.unsubscribe,
  validate(schemas.unsubscribe),
  asyncHandler(async (req, res) => {
    await unsubscribe.unsubscribeByToken(req.query.t, { via: 'one_click' });
    res.json({ ok: true });
  })
);
pub.get(
  '/unsubscribe',
  limit.unsubscribe,
  validate(schemas.unsubscribe),
  asyncHandler(async (req, res) => {
    // Opening the address never unsubscribes (mail scanners open links): it leads to the store's page, one button there.
    const row = await unsubscribe.recipientFor(req.query.t);
    const brand = await require('./campaignContent').storeBrand(row.workspaceId);
    const page = tokens.pageLink(brand && brand.origin, req.query.t);
    if (!page) throw new NotFoundError('Store');
    res.redirect(302, page);
  })
);

const store = Router({ mergeParams: true });
store.post(
  '/email-signup',
  gate,
  signupLimit.perIp,
  signupLimit.perStore,
  validate({
    body: Joi.object({
      email: Joi.string().trim().lowercase().email().max(254).required(),
      source: Joi.string().valid('footer', 'popup').required(),
      // A honeypot: people never see it, bots fill it in.
      website: Joi.string().max(500).allow('', null),
    }),
  }),
  asyncHandler(async (req, res) => res.json(await signup.subscribe(req.publicWorkspace, req.body)))
);

module.exports = { staff, public: pub, store };
