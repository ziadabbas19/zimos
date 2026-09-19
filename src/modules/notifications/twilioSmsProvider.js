'use strict';

const twilio = require('twilio');
const env = require('../../config/env');
const { withRetry } = require('../../core/utils/retry');

// 3 attempts: immediate, then ~1s, then ~3s. Zero delays under test.
const RETRY_DELAYS = env.isTest ? [0, 0, 0] : [0, 1000, 3000];

// Adapter over the Twilio REST client for outbound SMS.
let client = null;
function getClient() {
  const { accountSid, authToken } = env.notifications.twilio;
  if (!accountSid || !authToken) {
    throw new Error('Twilio SMS provider is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)');
  }
  if (!client) client = twilio(accountSid, authToken);
  return client;
}

async function sendSms({ to, body }) {
  const { fromNumber } = env.notifications.twilio;
  if (!fromNumber) throw new Error('Twilio SMS provider is missing TWILIO_FROM_NUMBER');

  const { value, attempts } = await withRetry(
    // Twilio's RestException carries `.status` (HTTP status) so the retry
    // layer skips a permanent 4xx (e.g. 21211 invalid 'To' number).
    () => getClient().messages.create({ from: fromNumber, to: `+${String(to).replace(/^\+/, '')}`, body }),
    { delays: RETRY_DELAYS }
  );

  return { sid: value.sid, attempts };
}

/**
 * Health probe for /admin/system/services. Fetching the account resource
 * proves the SID and auth token work and that Twilio is reachable, without
 * sending an SMS (which would cost money and pester a real handset). No
 * retry, for the same reason as the email probe: the tile should show the
 * flakiness, not paper over it.
 */
async function probe() {
  const { accountSid } = env.notifications.twilio;
  const account = await getClient().api.accounts(accountSid).fetch();
  return { detail: `twilio account ${account.friendlyName || accountSid} (${account.status})` };
}

// Lets tests drop the memoized client between runs.
function _resetClient() {
  client = null;
}

module.exports = { sendSms, probe, _resetClient };
