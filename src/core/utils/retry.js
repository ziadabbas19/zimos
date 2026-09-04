'use strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A failure is worth retrying only if it looks momentary: a network/timeout
 * error (no HTTP status at all), a 429, or a 5xx. A 4xx (bad recipient,
 * validation, auth) will never succeed on retry, so fail fast.
 */
function isTransient(err) {
  if (!err) return false;
  const status = err.status ?? err.statusCode;
  if (typeof status === 'number') {
    return status === 429 || (status >= 500 && status <= 599);
  }
  return true;
}

/**
 * Runs `fn` up to `delays.length` times, sleeping `delays[i]` ms before the
 * (i+1)-th attempt, but only retrying while `isRetryable(err)` holds. Resolves
 * `{ value, attempts }` on success; on exhaustion (or a non-retryable error)
 * re-throws the last error with `.attempts` set.
 */
async function withRetry(fn, { delays = [0, 1000, 3000], isRetryable = isTransient } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= delays.length; attempt += 1) {
    if (attempt > 1 && delays[attempt - 1] > 0) await sleep(delays[attempt - 1]);
    try {
      const value = await fn();
      return { value, attempts: attempt };
    } catch (err) {
      lastErr = err;
      if (attempt >= delays.length || !isRetryable(err)) {
        err.attempts = attempt;
        throw err;
      }
    }
  }
  throw lastErr; // unreachable — the loop always returns or throws
}

module.exports = { withRetry, isTransient };
