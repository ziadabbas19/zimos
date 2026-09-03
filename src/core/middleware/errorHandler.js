'use strict';

const { AppError } = require('../errors/AppError');
const logger = require('../utils/logger');
const env = require('../../config/env');

function notFoundHandler(req, res, next) {
  next(new AppError('ROUTE_NOT_FOUND', `Cannot ${req.method} ${req.originalUrl}`, 404));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const requestId = req.id;

  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error(err.message, { code: err.code, requestId, stack: err.stack });
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
