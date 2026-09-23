'use strict';

const env = require('../../../config/env');
const { withRetry } = require('../../../core/utils/retry');

/**
 * The one door every carrier adapter uses to reach its carrier. Plain fetch
 * (as notifications/brevoEmailProvider does), a hard timeout, and retries only
 * where they are safe.
 *
 * Tests stub `request` on this module (jest.spyOn(carrierHttp, 'request')), so
 * adapters must call it as `carrierHttp.request(...)`, never destructured.
 *
 * Resolves `{ status, ok, json, text, headers }` for ANY HTTP response — the
 * adapter decides what a 4xx means for its carrier. Rejects only when no
 * response arrived (timeout, DNS, connection reset) with a CarrierUnreachable
 * error.
 */

// Per attempt. A create gets longer: it runs under the order's row lock, but
// a create that times out leaves us not knowing whether the parcel exists,
// so it is worth waiting a little more for a definite answer.
const DEFAULT_TIMEOUT_MS = 10000;
const CREATE_TIMEOUT_MS = 15000;
// Reads only: immediate, then ~0.5s, then ~1.5s. Zero delays under test.
const READ_RETRY_DELAYS = env.isTest ? [0, 0, 0] : [0, 500, 1500];

class CarrierUnreachableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CarrierUnreachableError';
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
    throw new CarrierUnreachableError(err.name === 'TimeoutError' ? 'timed out' : 'could not connect');
  }
  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (err) {
    json = null;
  }
  return { status: res.status, ok: res.ok, json, text, headers: res.headers };
}

/**
 * @param {object}  opts
 * @param {string}  opts.method
 * @param {string}  opts.url
 * @param {object} [opts.headers]
 * @param {*}      [opts.body]       JSON-serialised when present
 * @param {number} [opts.timeoutMs]
 * @param {boolean}[opts.retry]      true only for idempotent reads. Never for a
 *                                   create: a retried create whose first
 *                                   attempt did land is a second parcel.
 */
async function request({ method = 'GET', url, headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, retry = false }) {
  const once = async () => {
    const res = await sendOnce({ method, url, headers, body, timeoutMs });
    if (retry && (res.status === 429 || res.status >= 500)) {
      // Thrown only so withRetry tries again; unwrapped below if it never recovers.
      const err = new Error(`carrier returned ${res.status}`);
      err.status = res.status;
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

module.exports = { request, CarrierUnreachableError, DEFAULT_TIMEOUT_MS, CREATE_TIMEOUT_MS };
