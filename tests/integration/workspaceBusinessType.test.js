'use strict';

// The store setup step asks what the store sells (optional, migration 753).
// The answer is stored on the workspace and shown read-only in the console.

const { app, request, registerAndActivate } = require('../helpers/factories');
const db = require('../../src/db/models');

const create = (token, body) =>
  request(app).post('/api/v1/workspaces').set('Authorization', `Bearer ${token}`).send(body);

describe('workspace business type', () => {
  it('stores a chosen type and drops a stray "other" text', async () => {
    const owner = await registerAndActivate();
    const res = await create(owner.accessToken, { name: 'Nile Threads', businessType: 'fashion', businessTypeOther: 'ignored' });
    expect(res.status).toBe(201);
    expect(res.body.workspace.businessType).toBe('fashion');
    expect(res.body.workspace.businessTypeOther).toBeNull();
  });

  it('keeps the text for "other", trimmed', async () => {
    const owner = await registerAndActivate();
    const res = await create(owner.accessToken, { name: 'Odd Things', businessType: 'other', businessTypeOther: '  handmade candles ' });
    expect(res.status).toBe(201);
    const row = await db.Workspace.findByPk(res.body.workspace.id);
    expect(row.businessType).toBe('other');
    expect(row.businessTypeOther).toBe('handmade candles');
  });

  it('is optional', async () => {
    const owner = await registerAndActivate();
    const res = await create(owner.accessToken, { name: 'No Answer' });
    expect(res.status).toBe(201);
    expect(res.body.workspace.businessType).toBeNull();
    expect(res.body.workspace.businessTypeOther).toBeNull();
  });

  it('refuses a type outside the list', async () => {
    const owner = await registerAndActivate();
    const res = await create(owner.accessToken, { name: 'Bad Type', businessType: 'weapons' });
    expect(res.status).toBe(422);
  });

  it('shows in the console store list', async () => {
    const owner = await registerAndActivate();
    const made = await create(owner.accessToken, { name: 'Beauty Corner', businessType: 'beauty' });
    const { listWorkspacesOverview } = require('../../src/modules/billing/billingService');
    const rows = await listWorkspacesOverview();
    const row = rows.find((r) => r.id === made.body.workspace.id);
    expect(row.businessType).toBe('beauty');
    expect(row.businessTypeOther).toBeNull();
  });
});
