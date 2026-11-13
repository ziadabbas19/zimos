'use strict';

const env = require('../../config/env');
const { withRetry } = require('../../core/utils/retry');

// Adapter over Brevo's transactional email API — plain fetch, no SDK.
// https://developers.brevo.com/reference/sendtransacemail
const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

// 3 attempts: immediate, then ~1s, then ~3s. Zero delays under test.
const RETRY_DELAYS = env.isTest ? [0, 0, 0] : [0, 1000, 3000];

// Per attempt. Without it a hung Brevo connection hangs the send indefinitely.
const SEND_TIMEOUT_MS = 10_000;

function buildPayload({ to, subject, html, text, fromAddress, fromName, replyTo, headers, tags }) {
  return {
    sender: { email: fromAddress, name: fromName },
    // A store's order emails: the customer's reply goes to the store (notifications/orderEmailSender.js).
    ...(replyTo ? { replyTo: { email: replyTo } } : {}),
    to: [{ email: to }],
    subject,
    htmlContent: html,
    textContent: text,
    // A campaign email's List-Unsubscribe headers and its tag (emailCampaigns/campaignProviders.js).
    ...(headers && Object.keys(headers).length ? { headers } : {}),
    ...(Array.isArray(tags) && tags.length ? { tags } : {}),
  };
}

async function sendOnce(payload, apiKey) {
  let res;
  try {
    res = await fetch(BREVO_ENDPOINT, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    // Same shape as an HTTP failure, minus `status`: the retry layer treats a
    // status-less error (timeout, connection reset) as transient.
    const reason = err.name === 'TimeoutError' ? `timed out after ${SEND_TIMEOUT_MS}ms` : err.message;
    throw new Error(`Brevo send failed: ${reason}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Brevo send failed: ${res.status} ${body}`.trim());
    err.status = res.status; // lets the retry layer tell transient (429/5xx) from permanent (4xx)
    throw err;
  }

  return res.json().catch(() => ({}));
}

async function sendEmail({ to, subject, html, text, fromName: senderName, replyTo, fromAddress: ownAddress, headers, tags, retry = true }) {
  const { apiKey, fromAddress, fromName } = env.notifications.brevo;
  if (!apiKey || !(ownAddress || fromAddress)) {
    throw new Error('Brevo email provider is not configured (BREVO_API_KEY / EMAIL_FROM_ADDRESS)');
  }

  // A store's email to its own customer goes out under the store's name (same sending address).
  // A campaign names its own address and headers, and retries on its own schedule (`retry: false`).
  const payload = buildPayload({ to, subject, html, text, fromAddress: ownAddress || fromAddress, fromName: senderName || fromName, replyTo, headers, tags });
  const { value, attempts } = await withRetry(() => sendOnce(payload, apiKey), { delays: retry ? RETRY_DELAYS : [0] });

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
