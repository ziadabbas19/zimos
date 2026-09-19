'use strict';

const env = require('../../config/env');
const { withRetry } = require('../../core/utils/retry');

// Adapter over Brevo's transactional email API — plain fetch, no SDK.
// https://developers.brevo.com/reference/sendtransacemail
const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

// 3 attempts: immediate, then ~1s, then ~3s. Zero delays under test.
const RETRY_DELAYS = env.isTest ? [0, 0, 0] : [0, 1000, 3000];

function buildPayload({ to, subject, html, text, fromAddress, fromName }) {
  return {
    sender: { email: fromAddress, name: fromName },
    to: [{ email: to }],
    subject,
    htmlContent: html,
    textContent: text,
  };
}

async function sendOnce(payload, apiKey) {
  const res = await fetch(BREVO_ENDPOINT, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Brevo send failed: ${res.status} ${body}`.trim());
    err.status = res.status; // lets the retry layer tell transient (429/5xx) from permanent (4xx)
    throw err;
  }

  return res.json().catch(() => ({}));
}

async function sendEmail({ to, subject, html, text }) {
  const { apiKey, fromAddress, fromName } = env.notifications.brevo;
  if (!apiKey || !fromAddress) {
    throw new Error('Brevo email provider is not configured (BREVO_API_KEY / EMAIL_FROM_ADDRESS)');
  }

  const payload = buildPayload({ to, subject, html, text, fromAddress, fromName });
  const { value, attempts } = await withRetry(() => sendOnce(payload, apiKey), { delays: RETRY_DELAYS });

  return { messageId: value.messageId || null, attempts };
}

/**
 * Health probe for /admin/system/services. GET /v3/account validates the API
 * key and reaches Brevo without sending anything — never probe a mail provider
 * by sending mail. No retry: a probe reports what is true right now, and
 * retrying would hide exactly the flakiness the tile exists to show.
 */
async function probe({ timeoutMs = 5000 } = {}) {
  const { apiKey } = env.notifications.brevo;
  if (!apiKey) throw new Error('BREVO_API_KEY is not set');

  const res = await fetch('https://api.brevo.com/v3/account', {
    headers: { 'api-key': apiKey, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brevo returned ${res.status} ${body}`.trim());
  }

  const account = await res.json().catch(() => ({}));
  return { detail: account.email ? `brevo account ${account.email}` : 'brevo' };
}

module.exports = { sendEmail, probe, buildPayload, BREVO_ENDPOINT };
