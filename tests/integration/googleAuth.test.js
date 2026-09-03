'use strict';

// Mock the Google profile fetch so no real consent flow is needed. Hoisted
// above the app require by Jest.
jest.mock('../../src/modules/auth/googleClient', () => ({
  getAuthUrl: jest.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?mock=1'),
  fetchProfile: jest.fn(),
}));
const googleClient = require('../../src/modules/auth/googleClient');

const { app, request } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

beforeEach(() => googleClient.fetchProfile.mockReset());

function query(location) {
  const u = new URL(location, 'http://placeholder');
  return {
    base: u.origin + u.pathname,
    accessToken: u.searchParams.get('accessToken'),
    refreshToken: u.searchParams.get('refreshToken'),
    error: u.searchParams.get('error'),
  };
}

const callback = (qs) => request(app).get(`/api/v1/auth/google/callback?${qs}`).redirects(0);

describe('Google OAuth login', () => {
  it('GET /auth/google redirects the browser to the Google consent screen', async () => {
    const res = await request(app).get('/api/v1/auth/google').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/accounts\.google\.com/);
  });

  it('a first Google login creates an active user with a googleId and no password', async () => {
    googleClient.fetchProfile.mockResolvedValueOnce({
      googleId: 'g-1001',
      email: 'newby@example.com',
      emailVerified: true,
      fullName: 'New Person',
    });

    const res = await callback('code=fake-auth-code');
    expect(res.status).toBe(302);

    const q = query(res.headers.location);
    expect(q.base).toBe(`${env.frontendUrl}/auth/callback`);
    expect(q.accessToken).toBeTruthy();
    expect(q.refreshToken).toBeTruthy();

    const user = await db.User.findOne({ where: { email: 'newby@example.com' } });
    expect(user).not.toBeNull();
    expect(user.googleId).toBe('g-1001');
    expect(user.passwordHash).toBeNull();
    expect(user.status).toBe('active');
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(await db.User.count({ where: { email: 'newby@example.com' } })).toBe(1);

    // the issued access token actually works
    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${q.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('newby@example.com');
  });

  it('a second Google login with the same googleId logs into the same account, no duplicate', async () => {
    googleClient.fetchProfile.mockResolvedValue({
      googleId: 'g-2002',
      email: 'repeat@example.com',
      emailVerified: true,
      fullName: 'Repeat User',
    });

    await callback('code=first');
    const first = await db.User.findOne({ where: { googleId: 'g-2002' } });

    await callback('code=second');
    const all = await db.User.findAll({ where: { googleId: 'g-2002' } });

    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(first.id);
  });

  it('Google login with an email matching an existing password account links instead of duplicating', async () => {
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'existing@example.com', password: 'Passw0rd!123', fullName: 'Existing User' });
    expect(reg.status).toBe(201);

    const before = await db.User.findOne({ where: { email: 'existing@example.com' } });
    expect(before.googleId).toBeNull();
    expect(before.passwordHash).toBeTruthy();

    googleClient.fetchProfile.mockResolvedValueOnce({
      googleId: 'g-3003',
      email: 'existing@example.com',
      emailVerified: true,
      fullName: 'Existing User',
    });

    const res = await callback('code=link-code');
    expect(res.status).toBe(302);
    expect(query(res.headers.location).accessToken).toBeTruthy();

    const after = await db.User.findAll({ where: { email: 'existing@example.com' } });
    expect(after).toHaveLength(1); // linked, not duplicated
    expect(after[0].id).toBe(before.id);
    expect(after[0].googleId).toBe('g-3003');
    expect(after[0].passwordHash).toBe(before.passwordHash); // password still there — both methods now work
  });

  it('a Google denial (?error=access_denied) redirects to the frontend with the error, no user created', async () => {
    const res = await callback('error=access_denied');
    expect(res.status).toBe(302);
    expect(query(res.headers.location).error).toBe('access_denied');
    expect(await db.User.count()).toBe(0);
  });
});
