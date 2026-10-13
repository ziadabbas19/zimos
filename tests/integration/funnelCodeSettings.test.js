'use strict';

// A funnel's scripts (settings.headCode / bodyCode, funnels/geoRedirects): the
// public funnel serves them off the funnel row, so saving one puts it live.
// Changing them takes funnels.publish, a confirmed account and a live store;
// the other settings keep funnels.manage.

const { app, request, registerAndActivate, createWorkspace, addMemberWithRole } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

async function setup() {
  const owner = await registerAndActivate();
  const workspace = await createWorkspace(owner.accessToken, 'Funnel Code Co');
  const base = `/api/v1/workspaces/${workspace.id}/funnels`;
  const funnel = (await request(app).post(base).set(bearer(owner.accessToken)).send({ name: 'Scripted Funnel' })).body.funnel;
  const settings = (token, body) => request(app).patch(`${base}/${funnel.id}/settings`).set(bearer(token)).send(body);
  return { owner, workspace, funnel, settings };
}

describe('funnel settings: head and body code', () => {
  it('a member with funnels.manage and no funnels.publish cannot change the scripts, and still saves the rest', async () => {
    const ctx = await setup();
    const editor = await addMemberWithRole(ctx.owner.accessToken, ctx.workspace.id, 'editor');

    const planted = await ctx.settings(editor.accessToken, { headCode: '<script>planted()</script>' });
    expect(planted.status).toBe(403);
    const both = await ctx.settings(editor.accessToken, { title: 'Editor title', bodyCode: '<script>planted()</script>' });
    expect(both.status).toBe(403);
    const stored = (await db.Funnel.findByPk(ctx.funnel.id)).settings || {};
    expect(stored.headCode || null).toBeNull();
    expect(stored.bodyCode || null).toBeNull();
    expect(stored.title || null).toBeNull();

    const title = await ctx.settings(editor.accessToken, { title: 'Editor title' });
    expect(title.status).toBe(200);
    expect(title.body.settings.title).toBe('Editor title');
  });

  it('the owner changes them, and an editor saving the form afterwards leaves them as they are', async () => {
    const ctx = await setup();
    const editor = await addMemberWithRole(ctx.owner.accessToken, ctx.workspace.id, 'editor');

    const set = await ctx.settings(ctx.owner.accessToken, { headCode: '<script>gtag()</script>' });
    expect(set.status).toBe(200);
    expect(set.body.settings.headCode).toBe('<script>gtag()</script>');

    // The whole form, scripts unchanged: saved.
    const form = await ctx.settings(editor.accessToken, { title: 'Editor title', headCode: '<script>gtag()</script>', bodyCode: '' });
    expect(form.status).toBe(200);
    // The same form with the script edited: refused whole.
    const edited = await ctx.settings(editor.accessToken, { title: 'Other title', headCode: '<script>other()</script>' });
    expect(edited.status).toBe(403);
    const stored = (await db.Funnel.findByPk(ctx.funnel.id)).settings;
    expect(stored).toMatchObject({ title: 'Editor title', headCode: '<script>gtag()</script>' });

    const audit = await db.AuditLog.findAll({ where: { action: 'funnel.settings', entityId: ctx.funnel.id } });
    expect(audit).toHaveLength(2);
  });
});
