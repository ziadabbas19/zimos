'use strict';

const crypto = require('crypto');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const { IdempotencyKeyReplayError, AppError } = require('../errors/AppError');

function hashBody(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body || {})).digest('hex');
}

/**
 * Requires an Idempotency-Key header. Inserts a row into idempotency_keys
 * (unique on workspace_id + scope + key) before running the handler, so only
 * the request that wins the insert race executes; the rest wait for and
 * replay its stored response. Reusing a key with a different body is
 * rejected rather than replaying a mismatched response.
 */
function idempotent(scope) {
  return (handler) =>
    asyncHandler(async (req, res, next) => {
      const key = req.headers['idempotency-key'];
      if (!key) {
        throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required', 400);
      }
      const workspaceId = req.tenant.workspaceId;
      const requestHash = hashBody(req.body);

      let record;
      try {
        record = await db.IdempotencyKey.create({
          workspaceId,
          scope,
          key,
          requestHash,
          status: 'processing',
        });
      } catch (err) {
        if (err.name !== 'SequelizeUniqueConstraintError') throw err;

        // Someone already claimed this key. Poll briefly for completion
        // (handles the case where the winning request is still in flight),
        // then either replay its response or reject a payload mismatch.
        const existing = await pollForCompletion(workspaceId, scope, key);

        // The unique-constraint violation means someone claimed this key, but
        // the row can be gone by the time we poll (e.g. the winner's
        // transaction was rolled back by a deadlock). Nothing to replay —
        // ask the client to retry rather than dereferencing a null row.
        if (!existing) {
          throw new AppError('IDEMPOTENCY_KEY_IN_PROGRESS', 'Request with this key is still being processed', 409);
        }

        if (existing.requestHash !== requestHash) {
          throw new IdempotencyKeyReplayError();
        }
        if (existing.status === 'completed') {
          return res.status(existing.responseStatus).json(existing.responseBody);
        }
        // Still processing after the poll window — ask the client to retry
        // rather than double-executing or hanging indefinitely.
        throw new AppError('IDEMPOTENCY_KEY_IN_PROGRESS', 'Request with this key is still being processed', 409);
      }

      // Capture the JSON response so we can store it against this key.
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        record
          .update({ status: 'completed', responseStatus: res.statusCode, responseBody: body })
          .catch(() => {});
        return originalJson(body);
      };

      try {
        await handler(req, res, next);
      } catch (err) {
        await record.update({ status: 'failed' }).catch(() => {});
        throw err;
      }
    });
}

async function pollForCompletion(workspaceId, scope, key, attempts = 10, delayMs = 150) {
  for (let i = 0; i < attempts; i++) {
    const row = await db.IdempotencyKey.findOne({ where: { workspaceId, scope, key } });
    if (row && row.status !== 'processing') return row;
    if (i === attempts - 1) return row;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

module.exports = { idempotent };
