'use strict';

/**
 * refunds.failure_code: a stable code for WHY a gateway refund failed, next
 * to the free-text failure_reason, so the dashboard can say what to do about
 * it. The one code so far is REFUND_INSUFFICIENT_GATEWAY_BALANCE — Kashier
 * pays refunds out of the merchant's available Kashier balance and refuses
 * one the balance cannot cover. NULL for every other failure and for every
 * existing row.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('refunds', 'failure_code', { type: Sequelize.STRING(60), allowNull: true });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('refunds', 'failure_code');
  },
};
