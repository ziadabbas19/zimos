'use strict';

const crypto = require('crypto');
const env = require('../../../config/env');
const logger = require('../../../core/utils/logger');

/**
 * Whether device notifications are on: PUSH_ENABLED and a usable VAPID pair
 * (config/env.js `push`). Everything in notifications/push asks isOn() and
 * does nothing while it answers false.
 *
 * A usable pair: the public key is a P-256 point (65 bytes, base64url), the
 * private key 32 bytes, the private key's own public key is that one (a pair
 * whose halves come from two runs of the generator would sign what no browser
 * accepts), and the subject a mailto: or https: address. Checked once per
 * value, since a test changes them on env.push; a pair that fails is reported
 * once, by what is wrong, never with the keys themselves.
 */

const decode = (value) => {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  return Buffer.from(value, 'base64url');
};

function problemWith({ vapidPublicKey, vapidPrivateKey, vapidSubject }) {
  if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) return 'VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are not all set';
  const publicKey = decode(vapidPublicKey);
  if (!publicKey || publicKey.length !== 65 || publicKey[0] !== 4) return 'VAPID_PUBLIC_KEY is not a 65-byte base64url key';
  const privateKey = decode(vapidPrivateKey);
  if (!privateKey || privateKey.length !== 32) return 'VAPID_PRIVATE_KEY is not a 32-byte base64url key';
  try {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(privateKey);
    if (!ecdh.getPublicKey().equals(publicKey)) return 'VAPID_PUBLIC_KEY is not the public half of VAPID_PRIVATE_KEY';
  } catch {
    return 'VAPID_PRIVATE_KEY is not a P-256 private key';
  }
  if (!/^mailto:[^\s@]+@[^\s@]+$/.test(vapidSubject) && !/^https:\/\/[^\s/]+/.test(vapidSubject)) {
    return 'VAPID_SUBJECT is not a mailto: or https:// address';
  }
  return null;
}

let checked = { key: null, problem: null };

function problem() {
  const { vapidPublicKey, vapidPrivateKey, vapidSubject } = env.push;
  const key = `${vapidPublicKey}\n${vapidPrivateKey}\n${vapidSubject}`;
  if (checked.key !== key) {
    checked = { key, problem: problemWith(env.push), warned: false };
  }
  return checked.problem;
}

/** True while PUSH_ENABLED is on and the VAPID pair is usable. */
function isOn() {
  if (env.push.enabled !== true) return false;
  const found = problem();
  if (found && !checked.warned) {
    checked.warned = true;
    logger.warn(`PUSH_ENABLED is on but push stays off: ${found}`);
  }
  return !found;
}

/** What browsers subscribe with (GET /me/push/config). */
const publicKey = () => env.push.vapidPublicKey;

/** For web-push's sendNotification. Only asked for while isOn(). */
const vapidDetails = () => ({ subject: env.push.vapidSubject, publicKey: env.push.vapidPublicKey, privateKey: env.push.vapidPrivateKey });

const maxDevicesPerUser = () => env.push.maxDevicesPerUser;

module.exports = { isOn, publicKey, vapidDetails, maxDevicesPerUser, problemWith };
