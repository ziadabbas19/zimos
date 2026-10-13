'use strict';

// The split-test routes with the session, the store and the model layer
// stubbed out: this file loads no models.
const mockExperiment = { findOne: jest.fn(), findAll: jest.fn(), create: jest.fn() };
jest.mock('../../src/db/models', () => ({
  Sequelize: { Op: {} },
  Experiment: mockExperiment,
  ExperimentAssignment: { destroy: jest.fn().mockResolvedValue(0), count: jest.fn().mockResolvedValue(0), findAll: jest.fn().mockResolvedValue([]) },
  FunnelStep: { findOne: jest.fn().mockResolvedValue({ id: 'step-1' }) },
}));
jest.mock('../../src/modules/audit/auditService', () => ({ recordAudit: jest.fn().mockResolvedValue() }));
jest.mock('../../src/modules/funnels/splitTestCountdowns', () => ({ forSave: async (ws, funnelId, variants) => variants }));
// Who is asking comes from a test header instead of a session.
jest.mock('../../src/core/middleware/authenticate', () => ({
  authenticate: (req, res, next) => {
    req.user = { id: 'user-1' };
    next();
  },
}));
jest.mock('../../src/core/middleware/tenantContext', () => ({
  resolveTenant: (req, res, next) => {
    const held = String(req.get('X-Test-Permissions') || '').split(',');
    req.tenant = { workspaceId: req.params.workspaceId, hasPermission: (p) => held.includes(p) };
    next();
  },
}));

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const { recordAudit } = require('../../src/modules/audit/auditService');
const { errorHandler } = require('../../src/core/middleware/errorHandler');
const splitTests = require('../../src/modules/funnels/splitTests');

const WS = '11111111-1111-4111-8111-111111111111';
const FUNNEL = '22222222-2222-4222-8222-222222222222';
const TEST = '33333333-3333-4333-8333-333333333333';
const small = express();
small.use(express.json());
small.use('/workspaces/:workspaceId/experiments', splitTests.router);
small.use(errorHandler);

const EDITOR = 'funnels.manage';
const PUBLISHER = 'funnels.manage,funnels.publish';
const as = (permissions) => ({
  get: (path = '') => request(small).get(`/workspaces/${WS}/experiments${path}`).set('X-Test-Permissions', permissions),
  post: (path, body) => request(small).post(`/workspaces/${WS}/experiments${path}`).set('X-Test-Permissions', permissions).send(body),
  patch: (path, body) => request(small).patch(`/workspaces/${WS}/experiments${path}`).set('X-Test-Permissions', permissions).send(body),
  del: (path) => request(small).delete(`/workspaces/${WS}/experiments${path}`).set('X-Test-Permissions', permissions),
});

const page = (text) => ({
  version: 1,
  sections: [{ id: 's1', type: 'section', rows: [{ id: 'r1', type: 'row', columns: [{ id: 'c1', type: 'column', span: 12, elements: [{ id: 'e1', type: 'text', props: { text } }] }] }] }],
});
const digestOf = (tree) => crypto.createHash('sha256').update(JSON.stringify(tree)).digest('hex');
const newTest = (text = 'Variant B copy') => ({
  funnelId: FUNNEL,
  stepKey: 'landing',
  name: 'Headline test',
  variants: [
    { key: 'A', weight: 50 },
    { key: 'B', weight: 50, builderData: page(text) },
  ],
});
function stored(fields = {}) {
  const row = {
    id: TEST,
    workspaceId: WS,
    funnelId: FUNNEL,
    stepKey: 'landing',
    name: 'Headline test',
    status: 'running',
    winnerVariantKey: null,
    variants: [
      { key: 'A', name: 'A', weight: 50, data: {} },
      { key: 'B', name: 'B', weight: 50, data: { builderData: page('Old B copy') } },
    ],
    ...fields,
    update: jest.fn(async (patch) => Object.assign(row, patch)),
    destroy: jest.fn().mockResolvedValue(),
  };
  return row;
}

// Split tests on a funnel step (funnels/splitTests): a variant's page reaches
// the shoppers of a live funnel the moment it is saved. So saving one takes
// the publish permission, and the audit row says what went live.
describe('split tests: who may put a variant live', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExperiment.findAll.mockResolvedValue([]);
    mockExperiment.findOne.mockResolvedValue(null);
    mockExperiment.create.mockImplementation(async (row) => ({ id: TEST, ...row }));
  });

  it('funnels.manage alone still reads, and no longer writes', async () => {
    const editor = as(EDITOR);
    expect((await editor.get()).status).toBe(200);

    mockExperiment.findOne.mockResolvedValue(stored());
    for (const res of [
      await editor.post('', newTest()),
      await editor.patch(`/${TEST}`, { variants: newTest().variants }),
      await editor.patch(`/${TEST}`, { status: 'paused' }),
      await editor.post(`/${TEST}/winner`, { variantKey: 'B' }),
      await editor.del(`/${TEST}`),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe('Missing required permission: funnels.publish');
    }
    expect(mockExperiment.create).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('funnels.publish without funnels.manage reaches nothing here, as before', async () => {
    expect((await as('funnels.publish').get()).status).toBe(403);
    expect((await as('funnels.publish').post('', newTest())).status).toBe(403);
  });

  it('a holder of both starts a test, and the audit row carries each variant page and its digest', async () => {
    const res = await as(PUBLISHER).post('', newTest('Buy two, get one'));
    expect(res.status).toBe(201);

    expect(recordAudit).toHaveBeenCalledTimes(1);
    const row = recordAudit.mock.calls[0][0];
    expect(row).toMatchObject({ action: 'split_test.create', entityType: 'Experiment', entityId: TEST, actorUserId: 'user-1' });
    expect(row.after).toMatchObject({ name: 'Headline test', funnelId: FUNNEL, stepKey: 'landing', status: 'running' });
    const [control, variant] = row.after.variants;
    // The control is the step's own page: nothing of its own to record.
    expect(control).toEqual({ key: 'A', name: 'A', weight: 50 });
    expect(variant).toMatchObject({ key: 'B', weight: 50, builderData: page('Buy two, get one'), pageDigest: digestOf(page('Buy two, get one')) });
  });

  it('changing the pages records the old digests before and the new pages after', async () => {
    mockExperiment.findOne.mockResolvedValue(stored());
    const res = await as(PUBLISHER).patch(`/${TEST}`, { variants: newTest('New B copy').variants });
    expect(res.status).toBe(200);

    const row = recordAudit.mock.calls[0][0];
    expect(row.action).toBe('split_test.update');
    expect(row.before.variants[1]).toEqual({ key: 'B', name: 'B', weight: 50, pageDigest: digestOf(page('Old B copy')) });
    expect(row.after.variants[1]).toMatchObject({ key: 'B', pageDigest: digestOf(page('New B copy')), builderData: page('New B copy') });
  });

  it('a change that leaves the pages alone records their digests, not the pages again', async () => {
    mockExperiment.findOne.mockResolvedValue(stored());
    expect((await as(PUBLISHER).patch(`/${TEST}`, { status: 'paused' })).status).toBe(200);
    const row = recordAudit.mock.calls[0][0];
    expect(row.before.status).toBe('running');
    expect(row.after.status).toBe('paused');
    expect(row.after.variants[1]).toEqual({ key: 'B', name: 'B', weight: 50, pageDigest: digestOf(page('Old B copy')) });
  });

  it('picking the winner records which page every visitor is served from then on', async () => {
    mockExperiment.findOne.mockResolvedValue(stored());
    expect((await as(PUBLISHER).post(`/${TEST}/winner`, { variantKey: 'B' })).status).toBe(200);
    const row = recordAudit.mock.calls[0][0];
    expect(row.action).toBe('split_test.winner');
    expect(row.before).toEqual({ status: 'running', winnerVariantKey: null });
    expect(row.after).toMatchObject({ status: 'completed', winnerVariantKey: 'B', by: 'merchant' });
    expect(row.after.variants[1].pageDigest).toBe(digestOf(page('Old B copy')));
  });

  it('deleting a test records what it was serving', async () => {
    mockExperiment.findOne.mockResolvedValue(stored());
    expect((await as(PUBLISHER).del(`/${TEST}`)).status).toBe(200);
    const row = recordAudit.mock.calls[0][0];
    expect(row.action).toBe('split_test.delete');
    expect(row.before.variants[1].pageDigest).toBe(digestOf(page('Old B copy')));
  });
});
