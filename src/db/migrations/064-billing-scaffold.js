'use strict';

/**
 * Subscription/plan scaffolding.
 *
 * - subscriptions.external_subscription_id / external_provider: nullable, for a
 *   future payment gateway's ids.
 * - subscriptions.plan_id: relaxed to nullable so a workspace can get a trialing
 *   subscription before any plans exist. Raw SQL because Sequelize changeColumn
 *   skips DROP NOT NULL when a `references` key is present.
 * - users.platform_admin: global "sees all workspaces" flag.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;

    await queryInterface.addColumn('subscriptions', 'external_subscription_id', {
      type: DataTypes.STRING(200),
      allowNull: true,
    });
    await queryInterface.addColumn('subscriptions', 'external_provider', {
      type: DataTypes.STRING(50),
      allowNull: true,
    });
    await queryInterface.sequelize.query('ALTER TABLE "subscriptions" ALTER COLUMN "plan_id" DROP NOT NULL;');

    await queryInterface.addColumn('users', 'platform_admin', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('users', 'platform_admin');
    await queryInterface.sequelize.query('ALTER TABLE "subscriptions" ALTER COLUMN "plan_id" SET NOT NULL;');
    await queryInterface.removeColumn('subscriptions', 'external_provider');
    await queryInterface.removeColumn('subscriptions', 'external_subscription_id');
  },
};
