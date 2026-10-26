'use strict';

// The activity log keeps a webhook endpoint's address as scheme, host and a
// fingerprint only (webhookService.auditUrl): a receiver's secret in the path
// or the query — an Apps Script ?token=, a Zapier hook id — never reaches
// anyone who can read the log.

const { app, request, setupWorkspaceWithProduct } = require('../helpers/factories');
const db = require('../../src/db/models');
const { auditUrl } = require('../../src/modules/webhooks/webhookService');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });

describe('webhook addresses in the activity log', () => {
  it('records scheme and host with a fingerprint, never the path or the token, on create, edit and delete', async () => {
    const { auth, workspace } = await setupWorkspaceWithProduct();
    const base = `/api/v1/workspaces/${workspace.id}/webhooks`;
    const first = 'https://script.google.com/macros/s/AKfycbSECRETDEPLOYID/exec?token=tok_5fGh7jK9LmN2pQ4r';
    const second = 'https://hooks.zapier.com/hooks/catch/123456/zapHookIdSecret/';

    const created = await request(app).post(base).set(bearer(auth.accessToken)).send({ url: first, events: ['order.accepted'] });
    expect(created.status).toBe(201);
    const id = created.body.endpoint.id;
    expect((await request(app).patch(`${base}/${id}`).set(bearer(auth.accessToken)).send({ url: second })).status).toBe(200);
    expect((await request(app).delete(`${base}/${id}`).set(bearer(auth.accessToken))).status).toBe(200);

    const rows = await db.AuditLog.findAll({ where: { workspaceId: workspace.id, entityType: 'WebhookEndpoint' } });
    expect(rows.map((r) => r.action).sort()).toEqual(['webhook_endpoint.create', 'webhook_endpoint.delete', 'webhook_endpoint.update']);
    const text = JSON.stringify(rows.map((r) => r.toJSON()));
    for (const secret of ['tok_5fGh7jK9LmN2pQ4r', 'AKfycbSECRETDEPLOYID', 'zapHookIdSecret', '/macros/', '/hooks/catch/']) expect(text).not.toContain(secret);

    const update = rows.find((r) => r.action === 'webhook_endpoint.update');
    expect(update.beforeState.url).toMatch(/^https:\/\/script\.google\.com\/… #[0-9a-f]{8}$/);
    expect(update.afterState.url).toMatch(/^https:\/\/hooks\.zapier\.com\/… #[0-9a-f]{8}$/);
    // Two addresses on one host still read as two.
    expect(auditUrl('https://a.example.com/x?token=1')).not.toBe(auditUrl('https://a.example.com/x?token=2'));
  });
});
