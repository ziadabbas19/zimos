'use strict';

const { AppError } = require('../errors/AppError');
const logger = require('../utils/logger');
const { redactUrl } = require('../utils/redactUrl');
const env = require('../../config/env');

const BODY_ERROR_CODES = {
  'entity.parse.failed': 'INVALID_JSON',
  'entity.too.large': 'PAYLOAD_TOO_LARGE',
  'charset.unsupported': 'UNSUPPORTED_MEDIA_TYPE',
  'encoding.unsupported': 'UNSUPPORTED_MEDIA_TYPE',
};

// The message is logged and answered, so a token in the path or the query
// (webhook tokens, signed links) is masked the way the request log masks it.
function notFoundHandler(req, res, next) {
  next(new AppError('ROUTE_NOT_FOUND', `Cannot ${req.method} ${redactUrl(req.originalUrl)}`, 404));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const requestId = req.id;

  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error(err.message, { code: err.code, requestId, stack: err.stack });
    } else if (err.statusCode === 424) {
      // A courier or payment gateway failed us (CARRIER_ERROR, GATEWAY_ERROR,
      // CARRIER_BOOKING_NOT_SAVED). Below 500 only so no edge proxy replaces
      // the answer; these still need seeing. Their details are already
      // sanitised by the adapters (codes and HTTP statuses, no credentials).
      logger.error(err.message, { code: err.code, requestId, details: err.details, stack: err.stack });
    } else {
      logger.warn(err.message, { code: err.code, requestId });
    }
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        requestId,
      },
    });
  }

  // The body parser's own refusals (malformed JSON, a body over the limit, an
  // unsupported charset) are the client's fault: their 4xx, not a 500.
  if (err.type && err.expose && err.status >= 400 && err.status < 500) {
    const code = BODY_ERROR_CODES[err.type] || 'BAD_REQUEST';
    logger.warn(err.message, { code, requestId });
    return res.status(err.status).json({
      error: { code, message: code === 'INVALID_JSON' ? 'Request body is not valid JSON' : err.message, requestId },
    });
  }

  // Sequelize-specific errors get mapped to safe, stable codes instead of leaking SQL.
  if (err.name === 'SequelizeUniqueConstraintError') {
    return res.status(409).json({
      error: { code: 'DUPLICATE_RESOURCE', message: 'Resource already exists', requestId },
    });
  }
  if (err.name === 'SequelizeValidationError') {
    return res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: err.errors?.map((e) => ({ field: e.path, message: e.message })),
        requestId,
      },
    });
  }
  if (err.name === 'SequelizeForeignKeyConstraintError') {
    return res.status(409).json({
      error: { code: 'INVALID_REFERENCE', message: 'Referenced resource does not exist or is not accessible', requestId },
    });
  }

  // Unexpected/unknown error: never leak internals.
  logger.error('Unhandled error', { message: err.message, stack: err.stack, requestId });
  return res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: env.isProduction ? 'An unexpected error occurred' : err.message,
      requestId,
    },
  });
}

module.exports = { errorHandler, notFoundHandler };
