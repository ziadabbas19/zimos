'use strict';

const { OAuth2Client } = require('google-auth-library');
const env = require('../../config/env');

const SCOPES = ['openid', 'email', 'profile'];

function client() {
  return new OAuth2Client(env.google.clientId, env.google.clientSecret, env.google.redirectUri);
}

/** URL of Google's consent screen. */
function getAuthUrl() {
  return client().generateAuthUrl({ access_type: 'offline', prompt: 'select_account', scope: SCOPES });
}

/**
 * Exchange the authorization code for the user's Google profile.
 * Kept in its own module so tests can mock it.
 */
async function fetchProfile(code) {
  const c = client();
  const { tokens } = await c.getToken(code);
  const ticket = await c.verifyIdToken({ idToken: tokens.id_token, audience: env.google.clientId });
  const p = ticket.getPayload();
  return {
    googleId: p.sub,
    email: p.email,
    emailVerified: p.email_verified === true,
    fullName: p.name || p.email,
  };
}

module.exports = { getAuthUrl, fetchProfile };
