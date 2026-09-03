'use strict';

const twilio = require('twilio');
const env = require('../../config/env');

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
  const msg = await getClient().messages.create({ from: fromNumber, to: `+${String(to).replace(/^\+/, '')}`, body });
  return { sid: msg.sid };
}

module.exports = { sendSms };
