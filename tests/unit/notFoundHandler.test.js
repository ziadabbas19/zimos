'use strict';

const { notFoundHandler } = require('../../src/core/middleware/errorHandler');

// The 404 for an unknown route (core/middleware/errorHandler): its message is
// logged and answered, so it carries the URL the way the request log does.
describe('notFoundHandler', () => {
  function messageFor(method, originalUrl) {
    const next = jest.fn();
    notFoundHandler({ method, originalUrl }, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('ROUTE_NOT_FOUND');
    return err.message;
  }

  it('masks a webhook token reached with the wrong method', () => {
    expect(messageFor('GET', '/api/v1/webhooks/payments/paymob/secret-token?hmac=abc')).toBe(
      'Cannot GET /api/v1/webhooks/payments/paymob/[redacted]?hmac=[redacted]'
    );
  });

  it('masks a storefront link token under an unknown path', () => {
    expect(messageFor('POST', '/api/v1/store/ws-1/recover/abc123def/extra')).toBe('Cannot POST /api/v1/store/ws-1/recover/[redacted]/extra');
  });

  it('keeps an ordinary unknown path as it was', () => {
    expect(messageFor('GET', '/api/v1/nope?page=2')).toBe('Cannot GET /api/v1/nope?page=2');
  });
});
