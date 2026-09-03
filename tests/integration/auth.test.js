'use strict';

const { app, request, registerAndActivate, uniqueEmail } = require('../helpers/factories');
const db = require('../../src/db/models');

describe('Authentication', () => {
  describe('registration', () => {
    it('registers a new user and returns tokens', async () => {
      const email = uniqueEmail();
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email, password: 'Passw0rd!123', fullName: 'Jane Doe' });

      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe(email);
      expect(res.body.user.passwordHash).toBeUndefined();
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.refreshToken).toBeDefined();
    });

    it('rejects duplicate email registration', async () => {
      const email = uniqueEmail();
      await request(app).post('/api/v1/auth/register').send({ email, password: 'Passw0rd!123', fullName: 'First User' });
      const res = await request(app).post('/api/v1/auth/register').send({ email, password: 'Passw0rd!123', fullName: 'Second User' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EMAIL_TAKEN');
    });

    it('rejects a weak/short password', async () => {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({ email: uniqueEmail(), password: '123', fullName: 'A' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('login', () => {
    it('logs in with correct credentials', async () => {
      const auth = await registerAndActivate();
      const res = await request(app).post('/api/v1/auth/login').send({ email: auth.email, password: auth.password });
      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeDefined();
    });

    it('rejects invalid credentials with a generic error (no user enumeration)', async () => {
      const auth = await registerAndActivate();
      const wrongPassword = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: auth.email, password: 'WrongPassword1!' });
      const noSuchUser = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: uniqueEmail(), password: 'WrongPassword1!' });

      expect(wrongPassword.status).toBe(401);
      expect(noSuchUser.status).toBe(401);
      expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(noSuchUser.body.error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('token refresh and revocation', () => {
    it('rotates the refresh token and the old one can no longer be used', async () => {
      const auth = await registerAndActivate();

      const refreshRes = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: auth.refreshToken });
      expect(refreshRes.status).toBe(200);
      expect(refreshRes.body.refreshToken).not.toBe(auth.refreshToken);

      // Reusing the original (now-rotated) refresh token must fail.
      const reuseRes = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: auth.refreshToken });
      expect(reuseRes.status).toBe(401);
      expect(reuseRes.body.error.code).toBe('REFRESH_TOKEN_REUSE_DETECTED');
    });

    it('reuse-detection revokes the whole session chain, including the newly rotated token', async () => {
      const auth = await registerAndActivate();
      const refreshRes = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: auth.refreshToken });
      const newRefreshToken = refreshRes.body.refreshToken;

      // Trigger reuse detection on the original token.
      await request(app).post('/api/v1/auth/refresh').send({ refreshToken: auth.refreshToken });

      // The legitimately-rotated token should now ALSO be revoked as a precaution.
      const secondRefresh = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: newRefreshToken });
      expect(secondRefresh.status).toBe(401);
    });

    it('logs out and revokes the session so refresh fails afterward', async () => {
      const auth = await registerAndActivate();
      const logoutRes = await request(app).post('/api/v1/auth/logout').send({ refreshToken: auth.refreshToken });
      expect(logoutRes.status).toBe(200);

      const refreshRes = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: auth.refreshToken });
      expect(refreshRes.status).toBe(401);
    });

    it('revoke-all-sessions invalidates every refresh token for the user', async () => {
      const auth = await registerAndActivate();
      // Create a second session by refreshing (does not revoke the ability to revoke-all).
      const revokeRes = await request(app)
        .post('/api/v1/auth/sessions/revoke-all')
        .set('Authorization', `Bearer ${auth.accessToken}`);
      expect(revokeRes.status).toBe(200);

      const refreshRes = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: auth.refreshToken });
      expect(refreshRes.status).toBe(401);
    });
  });

  describe('authorization header handling', () => {
    it('rejects requests with no Authorization header on a protected route', async () => {
      const res = await request(app).get('/api/v1/auth/me');
      expect(res.status).toBe(401);
    });

    it('rejects a malformed/garbage access token', async () => {
      const res = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer not-a-real-token');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_TOKEN');
    });

    it('accepts a valid access token', async () => {
      const auth = await registerAndActivate();
      const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${auth.accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe(auth.email);
    });
  });

  describe('password reset', () => {
    it('does not reveal whether an email is registered', async () => {
      const known = await registerAndActivate();
      const knownRes = await request(app).post('/api/v1/auth/password-reset/request').send({ email: known.email });
      const unknownRes = await request(app)
        .post('/api/v1/auth/password-reset/request')
        .send({ email: uniqueEmail() });

      expect(knownRes.status).toBe(200);
      expect(unknownRes.status).toBe(200);
      expect(knownRes.body).toEqual(unknownRes.body);
    });

    it('resets the password with a valid token and revokes existing sessions', async () => {
      const auth = await registerAndActivate();
      const user = await db.User.findOne({ where: { email: auth.email } });

      const rawToken = 'test-raw-token-1234567890';
      const { hashToken } = require('../../src/core/security/tokens');
      await db.VerificationToken.create({
        userId: user.id,
        type: 'password_reset',
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      const resetRes = await request(app)
        .post('/api/v1/auth/password-reset/confirm')
        .send({ token: rawToken, newPassword: 'NewPassw0rd!456' });
      expect(resetRes.status).toBe(200);

      // Old refresh token should now be revoked.
      const refreshRes = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: auth.refreshToken });
      expect(refreshRes.status).toBe(401);

      // New password should work.
      const loginRes = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: auth.email, password: 'NewPassw0rd!456' });
      expect(loginRes.status).toBe(200);
    });
  });
});
