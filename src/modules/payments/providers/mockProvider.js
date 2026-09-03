'use strict';

const crypto = require('crypto');

module.exports = {
  code: 'mock',
  async initialize({ amount, currency, orderId }) {
    return { providerReference: `mock_pi_${crypto.randomUUID()}`, status: 'authorized' };
  },
  async capture({ providerReference, amount }) {
    return { status: 'captured', capturedAmount: amount };
  },
  async refund({ providerReference, amount }) {
    return { status: 'refunded', refundedAmount: amount, providerRefundReference: `mock_re_${crypto.randomUUID()}` };
  },
  async getStatus({ providerReference }) {
    return { status: 'captured' };
  },
};
