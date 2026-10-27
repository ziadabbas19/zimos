'use strict';

const logger = require('../../../core/utils/logger');

/**
 * Invisible challenge (Cloudflare Turnstile and the like):
 * `verify(token, ip) → boolean`. The contract is in ./README.md.
 *
 * Nothing is active unless CAPTCHA_PROVIDER names a registered verifier; the
 * `sandbox` one is refused in production. With no active verifier the
 * checkout guard skips the challenge whatever the store's setting says.
 */

const TIMEOUT_MS = 3000;
// No verifier is connected yet: each one is added here by its name.
const verifiers = new Map();

/** Adds a real provider: `{ name, siteKey(), verify(token, ip) }`. */
function registerVerifier(verifier) {
  if (!verifier || typeof verifier.name !== 'string' || typeof verifier.verify !== 'function') {
    throw new Error('A captcha verifier needs a name and a verify(token, ip) function');
  }
  verifiers.set(verifier.name, verifier);
}

function active() {
  const wanted = process.env.CAPTCHA_PROVIDER;
  if (!wanted) return null;
  return verifiers.get(wanted) || null;
}

/** The verifier answering right now, or null. For settings screens. */
function providerName() {
  const verifier = active();
  return verifier ? verifier.name : null;
}

/** What the storefront needs to render the widget, or null when no challenge is active. */
function publicConfig() {
  const verifier = active();
  if (!verifier) return null;
  return { provider: verifier.name, siteKey: typeof verifier.siteKey === 'function' ? verifier.siteKey() : null };
}

/**
 * True when the token passes. A provider that fails or times out counts as a
 * pass: an outage at the challenge provider must not stop every checkout.
 */
async function verify(token, ip) {
  const verifier = active();
  if (!verifier) return true;
  if (typeof token !== 'string' || token === '') return false;
  let timer;
  try {
    const result = await Promise.race([
      verifier.verify(token, ip),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('captcha verification timed out')), TIMEOUT_MS);
      }),
    ]);
    return result === true || Boolean(result && result.success === true);
  } catch (err) {
    logger.warn('Captcha verification failed open', { provider: verifier.name, message: err.message });
    return true;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { registerVerifier, providerName, publicConfig, verify };
