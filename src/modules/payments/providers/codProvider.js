'use strict';

module.exports = {
  code: 'cod',
  async initialize({ amount, currency, orderId }) {
    return { providerReference: `cod_${orderId}`, status: 'authorized' };
  },
  async capture({ providerReference, amount }) {
    return { status: 'captured', capturedAmount: amount };
  },
  async refund({ providerReference, amount }) {
    return { status: 'refunded', refundedAmount: amount, providerRefundReference: `cod_refund_${providerReference}` };
  },
  async getStatus() {
    return { status: 'captured' };
  },
};
