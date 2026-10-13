'use strict';

// The feed route with the store gate and the model layer stubbed out: this
// file loads no models.
const mockGate = jest.fn();
jest.mock('../../src/db/models', () => ({ Sequelize: { Op: {}, QueryTypes: {} }, Workspace: { findOne: jest.fn() } }));
jest.mock('../../src/core/middleware/publicWorkspace', () => ({ resolvePublicWorkspace: (req, res, next) => mockGate(req, res, next) }));
jest.mock('../../src/modules/audit/auditService', () => ({ recordAudit: jest.fn() }));
jest.mock('../../src/modules/catalog/productPage', () => ({ effectiveVariantPrice: jest.fn() }));
jest.mock('../../src/modules/storefront/storeInfo', () => ({ resolveStoreInfo: jest.fn(), publicLegalIndex: jest.fn() }));

const express = require('express');
const request = require('supertest');
const db = require('../../src/db/models');
const { AppError, NotFoundError } = require('../../src/core/errors/AppError');
const { errorHandler } = require('../../src/core/middleware/errorHandler');
const { publicRouter } = require('../../src/modules/offers/productFeed');

const small = express();
small.use('/feeds', publicRouter);
small.use(errorHandler);

// The ad product feed (offers/productFeed): a public route, so its store is
// resolved by the gate every public route uses. A suspended, unpaid, draft or
// closed store serves no feed.
describe('product feed store gate', () => {
  beforeEach(() => {
    mockGate.mockReset();
    db.Workspace.findOne.mockReset();
  });

  it('asks the shared gate for the store, under the parameter name it reads', async () => {
    let asked = null;
    mockGate.mockImplementation((req, res, next) => {
      asked = req.params.workspaceId;
      next(new NotFoundError('Workspace'));
    });
    await request(small).get('/feeds/some-store/meta.xml');
    expect(mockGate).toHaveBeenCalledTimes(1);
    expect(asked).toBe('some-store');
  });

  it('serves nothing when the gate refuses: 423 for a restricted store, 404 for a closed or draft one', async () => {
    mockGate.mockImplementation((req, res, next) => next(new AppError('STORE_UNAVAILABLE', 'This store is currently unavailable.', 423)));
    const restricted = await request(small).get('/feeds/some-store/meta.xml');
    expect(restricted.status).toBe(423);
    expect(restricted.body.error.code).toBe('STORE_UNAVAILABLE');
    expect(restricted.headers['cache-control']).toBeUndefined();

    mockGate.mockImplementation((req, res, next) => next(new NotFoundError('Workspace')));
    expect((await request(small).get('/feeds/some-store/meta.xml')).status).toBe(404);
    // The route no longer looks the store up on its own.
    expect(db.Workspace.findOne).not.toHaveBeenCalled();
  });

  it('answers 404 past the gate for a feed that is switched off or a channel that is not one', async () => {
    mockGate.mockImplementation((req, res, next) => {
      req.publicWorkspace = { id: 'ws-1', name: 'Store', slug: 'some-store', settings: {} };
      next();
    });
    expect((await request(small).get('/feeds/some-store/meta.xml')).status).toBe(404);
    expect((await request(small).get('/feeds/some-store/nope.xml')).status).toBe(404);
  });
});
