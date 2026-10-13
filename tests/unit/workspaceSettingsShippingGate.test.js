'use strict';

// Only the permission check that runs before anything is written: the model
// layer is stubbed out, so this file loads no models.
const mockFindByPk = jest.fn();
jest.mock('../../src/db/models', () => ({
  Sequelize: { Op: {} },
  sequelize: {},
  Workspace: { findByPk: mockFindByPk },
  Session: { addHook: () => {} },
}));
// Collaborators that read their models when they load; none is reached here.
jest.mock('../../src/modules/billing/billingService', () => ({}));
jest.mock('../../src/modules/billing/entitlementsService', () => ({}));
jest.mock('../../src/modules/billing/publicPlansService', () => ({}));

const { PERMISSIONS } = require('../../src/core/security/permissions');
const workspaceService = require('../../src/modules/workspaces/workspaceService');

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const reqWith = (...permissions) => ({ user: { id: 'user-1' }, tenant: { hasPermission: (p) => permissions.includes(p) } });
const update = (settings, req) => workspaceService.updateWorkspace({ workspaceId: WORKSPACE, patch: { settings } }, req);

// PATCH /workspaces/:id (workspaces/workspaceService.updateWorkspace): the
// route asks for website.edit, which an Editor has. The keys that price
// delivery are also written by the shipping settings endpoint, which asks for
// shipping.manage — so they ask for it here too.
describe('store settings: shipping keys', () => {
  let workspace;
  beforeEach(() => {
    workspace = { id: WORKSPACE, name: 'Store', slug: 'store', settings: { default_shipping_rate_amount: 6000 }, update: jest.fn() };
    mockFindByPk.mockReset().mockResolvedValue(workspace);
  });

  it.each([
    ['the free-shipping threshold', { free_shipping_threshold_amount: 0 }],
    ['the default rate', { default_shipping_rate_amount: 0 }],
    ['the default item weight', { default_item_weight_grams: 1 }],
    ['a key set to null', { default_shipping_rate_amount: null }],
    ['a shipping key next to one an Editor may change', { tracking_pixels: {}, free_shipping_threshold_amount: 1 }],
  ])('refuses %s without shipping.manage and writes nothing', async (_name, settings) => {
    await expect(update(settings, reqWith(PERMISSIONS.WEBSITE_EDIT))).rejects.toMatchObject({
      statusCode: 403,
      message: 'Changing shipping settings requires the shipping.manage permission',
    });
    expect(workspace.update).not.toHaveBeenCalled();
    expect(workspace.settings).toEqual({ default_shipping_rate_amount: 6000 });
  });

  it('does not ask for it when no shipping key is named', async () => {
    // Refused or accepted for other reasons further on, but not by this check.
    const outcome = await update({ tracking_pixels: {} }, reqWith(PERMISSIONS.WEBSITE_EDIT)).then(
      () => null,
      (err) => err
    );
    expect(outcome && outcome.message).not.toBe('Changing shipping settings requires the shipping.manage permission');
  });

  it('lets a holder of shipping.manage past the check', async () => {
    const outcome = await update({ default_shipping_rate_amount: 5000 }, reqWith(PERMISSIONS.WEBSITE_EDIT, PERMISSIONS.SHIPPING_MANAGE)).then(
      () => null,
      (err) => err
    );
    expect(outcome && outcome.message).not.toBe('Changing shipping settings requires the shipping.manage permission');
  });

  it('leaves the tax switch to the route permission, as before', async () => {
    const outcome = await update({ tax_enabled: false }, reqWith(PERMISSIONS.WEBSITE_EDIT)).then(
      () => null,
      (err) => err
    );
    expect(outcome && outcome.statusCode).not.toBe(403);
  });
});
