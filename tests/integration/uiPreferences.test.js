'use strict';

// The look of the dashboard, saved to the signed-in account so it follows its
// owner from one device to another (auth/uiPreferencesService, migration 701):
//
//   GET   /auth/me/ui-preferences
//   PATCH /auth/me/ui-preferences   { appearance: { look, darkTone, glass, glowLeft, glowRight, glowIntensity } }
//
// What a save may hold is tested without the database in
// tests/unit/uiPreferences.test.js; here, the routes and the column.

const { app, request, registerAndActivate } = require('../helpers/factories');
const db = require('../../src/db/models');
const { MAX_BODY_BYTES } = require('../../src/modules/auth/uiPreferences');

const URL = '/api/v1/auth/me/ui-preferences';
const auth = (who) => ({ Authorization: `Bearer ${who.accessToken}` });
const read = (who) => request(app).get(URL).set(auth(who));
const save = (who, appearance) => request(app).patch(URL).set(auth(who)).send({ appearance });
const look = (over = {}) => ({ look: 'dark', darkTone: 30, glass: true, glowLeft: '#1a2b3c', glowRight: null, glowIntensity: 80, ...over });

/** The row as it is in the database. */
async function row(userId) {
  const [found] = await db.sequelize.query('SELECT ui_preferences, updated_at FROM users WHERE id = :userId', {
    replacements: { userId },
    type: db.Sequelize.QueryTypes.SELECT,
  });
  return found;
}

describe('the look saved to the account', () => {
  it('is null until the account saves, then answers what was saved and when', async () => {
    const a = await registerAndActivate();
    const before = await read(a);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ uiPreferences: null });

    const from = Date.now();
    const res = await save(a, look({ glowLeft: '#1A2B3C' }));
    expect(res.status).toBe(200);
    const { updatedAt, ...values } = res.body.uiPreferences.appearance;
    expect(values).toEqual(look());
    expect(new Date(updatedAt).toISOString()).toBe(updatedAt);
    expect(Date.parse(updatedAt)).toBeGreaterThanOrEqual(from);
    expect(Date.parse(updatedAt)).toBeLessThanOrEqual(Date.now());

    const after = await read(a);
    expect(after.status).toBe(200);
    expect(after.body).toEqual(res.body);
  });

  it('belongs to the account that saved it', async () => {
    const a = await registerAndActivate();
    const b = await registerAndActivate();
    expect((await save(a, look())).status).toBe(200);
    expect((await read(b)).body).toEqual({ uiPreferences: null });

    expect((await save(b, look({ look: 'black', glowLeft: null, darkTone: 50 }))).status).toBe(200);
    expect((await read(a)).body.uiPreferences.appearance).toMatchObject(look());
    expect((await read(b)).body.uiPreferences.appearance).toMatchObject({ look: 'black', glowLeft: null, darkTone: 50 });
  });

  it('replaces the appearance whole, and leaves any other part of the value alone', async () => {
    const a = await registerAndActivate();
    await db.sequelize.query('UPDATE users SET ui_preferences = CAST(:value AS jsonb) WHERE id = :userId', {
      replacements: { userId: a.userId, value: JSON.stringify({ layout: { dense: true } }) },
    });
    expect((await read(a)).body).toEqual({ uiPreferences: null });

    expect((await save(a, look({ glowRight: '#ffaa00' }))).status).toBe(200);
    const next = look({ look: null, glowLeft: null, glowRight: null, darkTone: 50, glowIntensity: 100, glass: false });
    const res = await save(a, next);
    expect(res.status).toBe(200);
    expect(res.body.uiPreferences.appearance).toMatchObject(next);
    expect(Object.keys(res.body.uiPreferences)).toEqual(['appearance']);

    const kept = (await row(a.userId)).ui_preferences;
    expect(kept.layout).toEqual({ dense: true });
    expect(kept.appearance).toMatchObject(next);
  });

  it('changes nothing else on the account, and is not part of /auth/me', async () => {
    const a = await registerAndActivate();
    const before = await row(a.userId);
    expect((await save(a, look())).status).toBe(200);
    expect(new Date((await row(a.userId)).updated_at).getTime()).toBe(new Date(before.updated_at).getTime());

    const me = await request(app).get('/api/v1/auth/me').set(auth(a));
    expect(me.status).toBe(200);
    expect(me.body).not.toHaveProperty('uiPreferences');
    expect(me.body.user).not.toHaveProperty('uiPreferences');
    expect(me.body.user).not.toHaveProperty('ui_preferences');
  });

  it('refuses what it does not know, and keeps nothing of it', async () => {
    const a = await registerAndActivate();
    const bodies = [
      { appearance: { ...look(), theme: 'neon' } },
      { appearance: { ...look(), updatedAt: '2099-01-01T00:00:00.000Z' } },
      { appearance: look(), language: 'ar' },
      { appearance: look({ look: 'blue' }) },
      { appearance: look({ darkTone: '30' }) },
      { appearance: look({ darkTone: 101 }) },
      { appearance: look({ glass: 'true' }) },
      { appearance: look({ glowLeft: '<b>#1a2b3c</b>' }) },
      { appearance: look({ glowRight: 'red' }) },
      { appearance: { look: 'dark' } },
      {},
    ];
    for (const body of bodies) {
      const res = await request(app).patch(URL).set(auth(a)).send(body);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await row(a.userId)).ui_preferences).toBeNull();
    expect((await read(a)).body).toEqual({ uiPreferences: null });
  });

  it('refuses a body over the size limit', async () => {
    const a = await registerAndActivate();
    const res = await request(app)
      .patch(URL)
      .set(auth(a))
      .send({ appearance: look(), padding: 'x'.repeat(MAX_BODY_BYTES) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect((await row(a.userId)).ui_preferences).toBeNull();
  });

  it('needs a signed-in account', async () => {
    const a = await registerAndActivate();
    expect((await request(app).get(URL)).status).toBe(401);
    expect((await request(app).patch(URL).send({ appearance: look() })).status).toBe(401);
    expect((await request(app).patch(URL).set({ Authorization: 'Bearer not-a-token' }).send({ appearance: look() })).status).toBe(401);
    expect((await row(a.userId)).ui_preferences).toBeNull();
  });
});
