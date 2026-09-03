'use strict';

/**
 * All intentional, expected failures in the system should throw an AppError
 * (or a subclass) rather than a bare Error, so the central error handler can
 * emit a stable machine-readable code and the correct HTTP status without
 * ever leaking internals (SQL errors, stack traces, secrets) to the client.
 */
class AppError extends Error {
  constructor(code, message, statusCode = 400, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(details, message = 'Validation failed') {
    super('VALIDATION_ERROR', message, 422, details);
  }
}

class AuthenticationError extends AppError {
  constructor(message = 'Authentication required', code = 'UNAUTHENTICATED') {
    super(code, message, 401);
  }
}

class AuthorizationError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super('FORBIDDEN', message, 403);
  }
}

class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super('NOT_FOUND', `${resource} not found`, 404);
  }
}

class ConflictError extends AppError {
  constructor(message = 'Conflict', code = 'CONFLICT') {
    super(code, message, 409);
  }
}

class RateLimitError extends AppError {
  constructor(message = 'Too many requests') {
    super('RATE_LIMITED', message, 429);
  }
}

class IdempotencyKeyReplayError extends AppError {
  constructor(message = 'Request already processed with a different payload') {
    super('IDEMPOTENCY_KEY_CONFLICT', message, 409);
  }
}

class InsufficientStockError extends AppError {
  constructor(message = 'Insufficient stock available') {
    super('INSUFFICIENT_STOCK', message, 409);
  }
}

module.exports = {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  IdempotencyKeyReplayError,
  InsufficientStockError,
};
