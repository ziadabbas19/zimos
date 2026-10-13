'use strict';

// Split tests on a funnel step (funnels/splitTests): a variant's page is
// served to the shoppers of a published funnel as soon as it is saved, so
// saving one takes funnels.publish, and its audit row carries the page.

const { app, request, registerAndActivate, createWorkspace, addMemberWithRole } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

const tree = (text) => ({
  version: 1,
  sections: [
    {
      id: 's1',
      type: 'section',
      rows: [{ id: 'r1', type: 'row', columns: [{ id: 'c1', type: 'column', span: 12, elements: [{ id: 'e1', type: 'text', props: { text } }] }] }],
    },
  ],
});

/** A published two-step funnel: landing --always--> thanks. */
async function setup() {
  const owner = await registerAndActivate();
  const workspace = await createWorkspace(owner.accessToken, 'Split Test Co');
  const H = bearer(owner.accessToken);
  const base = `/api/v1/workspaces/${workspace.id}`;
  const funnel = (await request(app).post(`${base}/funnels`).set(H).send({ name: 'Tested Funnel' })).body.funnel;
  const step = (body) => request(app).post(`${base}/funnels/${funnel.id}/steps`).set(H).send(body);
  await step({ key: 'landing', stepType: 'landing', name: 'L', builderData: tree('Original headline') });
  await step({ key: 'thanks', stepType: 'thank_you', name: 'T', builderData: tree('Thanks') });
  await request(app)
    .post(`${base}/funnels/${funnel.id}/edges`)
    .set(H)
    .send({ fromStepKey: 'landing', toStepKey: 'thanks', condition: { type: 'always' } });
  const published = await request(app).post(`${base}/funnels/${funnel.id}/publish`).set(H).send({});
  if (published.status !== 201) throw new Error(`publish failed: ${published.status} ${JSON.stringify(published.body)}`);
  const test = (text = 'Variant headline') => ({
    funnelId: funnel.id,
    stepKey: 'landing',
    name: 'Headline test',
    // Every visitor gets B, so what a shopper is served is not left to chance.
    variants: [
      { key: 'A', weight: 0 },
      { key: 'B', weight: 100, builderData: tree(text) },
    ],
  });
  return { owner, workspace, H, base, funnel, test };
}

const landingFor = (ctx, visitorId) =>
  request(app).post(`/api/v1/store/${ctx.workspace.id}/funnels/${ctx.funnel.id}/sessions`).send({ visitorId });

describe('split tests', () => {
  it('a member with funnels.manage and no funnels.publish reads tests and cannot put a variant live', async () => {
    const ctx = await setup();
    const editor = await addMemberWithRole(ctx.owner.accessToken, ctx.workspace.id, 'editor');
    const E = bearer(editor.accessToken);

    expect((await request(app).get(`${ctx.base}/experiments`).set(E)).status).toBe(200);
    const refused = await request(app).post(`${ctx.base}/experiments`).set(E).send(ctx.test('Planted by an editor'));
    expect(refused.status).toBe(403);
    expect(await db.Experiment.count({ where: { workspaceId: ctx.workspace.id } })).toBe(0);

    // The shopper is still served the published page.
    const served = await landingFor(ctx, 'visitor-1');
    expect(served.status).toBe(201);
    expect(JSON.stringify(served.body.step.tree)).toContain('Original headline');
    expect(JSON.stringify(served.body.step.tree)).not.toContain('Planted by an editor');

    // Nor change, finish or delete one that exists.
    const started = await request(app).post(`${ctx.base}/experiments`).set(ctx.H).send(ctx.test());
    expect(started.status).toBe(201);
    const id = started.body.experiment.id;
    expect((await request(app).get(`${ctx.base}/experiments/${id}`).set(E)).status).toBe(200);
    expect((await request(app).patch(`${ctx.base}/experiments/${id}`).set(E).send({ variants: ctx.test('Swapped').variants })).status).toBe(403);
    expect((await request(app).post(`${ctx.base}/experiments/${id}/winner`).set(E).send({ variantKey: 'B' })).status).toBe(403);
    expect((await request(app).delete(`${ctx.base}/experiments/${id}`).set(E)).status).toBe(403);
    expect((await db.Experiment.findByPk(id)).status).toBe('running');
  });

  it('what a holder of funnels.publish starts is served at once, and the audit row holds the page', async () => {
    const ctx = await setup();
    const started = await request(app).post(`${ctx.base}/experiments`).set(ctx.H).send(ctx.test('Variant headline'));
    expect(started.status).toBe(201);

    const served = await landingFor(ctx, 'visitor-2');
    expect(JSON.stringify(served.body.step.tree)).toContain('Variant headline');
    expect(served.body.splitTest).toMatchObject({ id: started.body.experiment.id, variantKey: 'B' });

    const audit = await db.AuditLog.findOne({ where: { action: 'split_test.create', entityId: started.body.experiment.id } });
    const variant = audit.afterState.variants.find((v) => v.key === 'B');
    expect(JSON.stringify(variant.builderData)).toContain('Variant headline');
    expect(variant.pageDigest).toMatch(/^[0-9a-f]{64}$/);

    // A new page for B: the row keeps the digest it replaced and the page that replaced it.
    const changed = await request(app)
      .patch(`${ctx.base}/experiments/${started.body.experiment.id}`)
      .set(ctx.H)
      .send({ variants: ctx.test('Second headline').variants });
    expect(changed.status).toBe(200);
    const update = await db.AuditLog.findOne({ where: { action: 'split_test.update', entityId: started.body.experiment.id } });
    expect(update.beforeState.variants.find((v) => v.key === 'B').pageDigest).toBe(variant.pageDigest);
    expect(JSON.stringify(update.afterState.variants.find((v) => v.key === 'B').builderData)).toContain('Second headline');
  });
});
