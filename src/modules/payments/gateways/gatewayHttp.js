'use strict';

const env = require('../../../config/env');
const { withRetry } = require('../../../core/utils/retry');

/**
 * The one door every gateway adapter uses to reach its gateway — the same
 * shape as shipping/carriers/carrierHttp.js: plain fetch, a hard timeout, and
 * retries only where they are safe.
 *
 * Tests stub `request` on this module (jest.spyOn(gatewayHttp, 'request')),
 * so adapters must call it as `gatewayHttp.request(...)`, never destructured.
 * The suite never reaches a real gateway.
 *
 * Resolves `{ status, ok, json, text }` for ANY HTTP response — the adapter
 * decides what a 4xx means. Rejects only when no response arrived (timeout,
 * DNS, connection reset) with a GatewayUnreachableError.
 */

const DEFAULT_TIMEOUT_MS = 10000;
// A payment create or a refund: a timeout leaves us not knowing whether it
// happened, so it is worth waiting a little longer for a definite answer.
const WRITE_TIMEOUT_MS = 15000;
const READ_RETRY_DELAYS = env.isTest ? [0, 0, 0] : [0, 500, 1500];

class GatewayUnreachableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GatewayUnreachableError';
  }
}

async function sendOnce({ method, url, headers, body, timeoutMs }) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new GatewayUnreachableError(err.name === 'TimeoutError' ? 'timed out' : 'could not connect');
  }
  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (err) {
    json = null;
  }
  return { status: res.status, ok: res.ok, json, text };
}

/**
 * @param {boolean} [opts.retry]  true only for reads. Never for a payment
 *                                create or a refund: a retried refund whose
 *                                first attempt landed refunds twice.
 */
async function request({ method = 'GET', url, headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, retry = false }) {
  const once = async () => {
    const res = await sendOnce({ method, url, headers, body, timeoutMs });
    if (retry && (res.status === 429 || res.status >= 500)) {
      const err = new Error(`gateway returned ${res.status}`);
      err.response = res;
      throw err;
    }
    return res;
  };

  if (!retry) return once();
  try {
    const { value } = await withRetry(once, { delays: READ_RETRY_DELAYS });
    return value;
  } catch (err) {
    if (err.response) return err.response;
    throw err;
  }
}

module.exports = { request, GatewayUnreachableError, DEFAULT_TIMEOUT_MS, WRITE_TIMEOUT_MS };
