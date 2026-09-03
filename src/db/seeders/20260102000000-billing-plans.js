'use strict';

/**
 * Seed the default plan set (free / starter / growth). Idempotent via
 * findOrCreate on `plans.key`, so it's safe to re-run and to run alongside
 * the demo seeder.
 */
module.exports = {
  up: async () => {
    const billingService = require('../../modules/billing/billingService');
    await billingService.seedDefaultPlans();
  },
  down: async (queryInterface) => {
    // Only remove the plan this seeder solely owns. `starter` / `growth` are
    // also created by the demo seeder (and referenced by the demo
    // Subscription), so leave them for the demo seeder's own `down`.
    await queryInterface.bulkDelete('plans', { key: ['free'] }, {});
  },
};
