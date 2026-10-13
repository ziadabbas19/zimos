'use strict';

// The funnel settings route with its storage stubbed out: this file loads no models.
const mockFunnelFindOne = jest.fn();
jest.mock('../../src/db/models', () => ({
  Sequelize: { Op: {} },
  Funnel: { findOne: mockFunnelFindOne },
  ShippingProfile: { findOne: jest.fn() },
  GeoRedirect: {},
}));
jest.mock('../../src/modules/audit/auditService', () => ({ recordAudit: jest.fn().mockResolvedValue() }));

const express = require('express');
const request = require('supertest');
const { AppError } = require('../../src/core/errors/AppError');
const { requirePermission } = require('../../src/core/middleware/rbac');
const { errorHandler } = require('../../src/core/middleware/errorHandler');
const { recordAudit } = require('../../src/modules/audit/auditService');
const geoRedirects = require('../../src/modules/funnels/geoRedirects');

const WS = '11111111-1111-4111-8111-111111111111';
const FUNNEL = '22222222-2222-4222-8222-222222222222';
const SCRIPT = '<script>window.pixel = 1</script>';

// The same three guards the funnel's publish route takes, with the account and
// the store's state read from test headers.
const requireConfirmedAccount = (req, res, next) =>
  req.get('X-Test-Confirmed') === 'no' ? next(new AppError('EMAIL_NOT_VERIFIED', 'Confirm your email address first.', 403)) : next();
const requireLive = (req, res, next) =>
  req.get('X-Test-Store') === 'draft' ? next(new AppError('SUBSCRIPTION_REQUIRED', 'Subscribe to go live.', 403)) : next();

const small = express();
small.use(express.json());
const router = express.Router({ mergeParams: true });
router.use((req, res, next) => {
  const held = String(req.get('X-Test-Permissions') || '').split(',');
  req.user = { id: 'user-1' };
  req.tenant = { workspaceId: req.params.workspaceId, hasPermission: (p) => held.includes(p) };
  next();
});
geoRedirects.mount(router, {
  MANAGE: requirePermission('funnels.manage'),
  LIVE_CONTENT: [requirePermission('funnels.publish'), requireConfirmedAccount, requireLive],
});
small.use('/workspaces/:workspaceId/funnels', router);
small.use(errorHandler);

const EDITOR = 'funnels.manage';
const PUBLISHER = 'funnels.manage,funnels.publish';
const save = (body, permissions, headers = {}) =>
  request(small).patch(`/workspaces/${WS}/funnels/${FUNNEL}/settings`).set('X-Test-Permissions', permissions).set(headers).send(body);

// A funnel's settings (funnels/geoRedirects): headCode and bodyCode are scripts
// the public funnel serves off the funnel row on every step, so a new value is
// live the moment it is saved. Changing them takes what a publish takes; the
// other settings keep funnels.manage.
describe('funnel settings: the scripts are live content', () => {
  let funnel;
  beforeEach(() => {
    recordAudit.mockClear();
    funnel = { id: FUNNEL, settings: { title: 'Old title', headCode: SCRIPT }, update: jest.fn(async (patch) => Object.assign(funnel, patch)) };
    mockFunnelFindOne.mockReset().mockResolvedValue(funnel);
  });

  it('a member with funnels.manage alone still saves the other settings', async () => {
    const res = await save({ title: 'New title', description: 'About it', currency: 'egp' }, EDITOR);
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({ title: 'New title', description: 'About it', currency: 'EGP', headCode: SCRIPT });
    expect(funnel.update).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a new head script', { headCode: '<script>steal()</script>' }],
    ['a new body script', { bodyCode: '<script>steal()</script>' }],
    ['clearing the head script', { headCode: null }],
    ['a script next to a setting they may change', { title: 'New title', bodyCode: '<img src=x onerror=1>' }],
  ])('refuses %s from a member without funnels.publish, and saves none of the request', async (_name, body) => {
    const res = await save(body, EDITOR);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Missing required permission: funnels.publish');
    expect(funnel.update).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    expect(funnel.settings).toEqual({ title: 'Old title', headCode: SCRIPT });
  });

  it('a script sent back as it is stored is not a change: the form still saves', async () => {
    const res = await save({ title: 'New title', headCode: `  ${SCRIPT}  `, bodyCode: '' }, EDITOR);
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({ title: 'New title', headCode: SCRIPT, bodyCode: null });
  });

  it('a holder of funnels.publish changes the scripts, on a confirmed account and a live store', async () => {
    const res = await save({ headCode: '<script>gtag()</script>', bodyCode: '<noscript></noscript>' }, PUBLISHER);
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({ headCode: '<script>gtag()</script>', bodyCode: '<noscript></noscript>', title: 'Old title' });
    expect(recordAudit.mock.calls[0][0]).toMatchObject({ action: 'funnel.settings', before: { headCode: SCRIPT }, after: { headCode: '<script>gtag()</script>' } });
  });

  it('asks for the confirmed account and the live store as a publish does, in that order', async () => {
    const unconfirmed = await save({ headCode: '<script>x()</script>' }, PUBLISHER, { 'X-Test-Confirmed': 'no', 'X-Test-Store': 'draft' });
    expect(unconfirmed.status).toBe(403);
    expect(unconfirmed.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    const draft = await save({ headCode: '<script>x()</script>' }, PUBLISHER, { 'X-Test-Store': 'draft' });
    expect(draft.status).toBe(403);
    expect(draft.body.error.code).toBe('SUBSCRIPTION_REQUIRED');
    expect(funnel.update).not.toHaveBeenCalled();

    // Neither stands in the way of the other settings.
    expect((await save({ title: 'New title' }, PUBLISHER, { 'X-Test-Confirmed': 'no', 'X-Test-Store': 'draft' })).status).toBe(200);
  });

  it('funnels.manage is still needed for any of it', async () => {
    expect((await save({ title: 'New title' }, 'funnels.publish')).status).toBe(403);
    expect((await save({ title: 'New title' }, '')).status).toBe(403);
  });
});
