'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Core Web Vitals from a small sample of real visits to a store
 * (analytics/webVitals, WEB_VITALS_ENABLED; off, nothing is written). One row per
 * metric. Nothing about the visitor: no IP, no id, no address, only which kind of
 * page it was and whether it was a phone. Old rows go after
 * WEB_VITALS_RETENTION_DAYS. A new table, so no existing row or lock is touched.
 */
const METRICS = ['LCP', 'INP', 'CLS', 'TTFB'];
const ROUTES = ['home', 'listing', 'product', 'cart', 'checkout', 'page', 'other'];
const DEVICES = ['mobile', 'desktop'];
const list = (values) => values.map((v) => `'${v}'`).join(', ');

module.exports = {
  up: async (queryInterface, Sequelize) => {
    queryInterface = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'store_web_vitals',
        {
          id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
          workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE' },
          metric: { type: DataTypes.STRING(8), allowNull: false },
          value: { type: DataTypes.DOUBLE, allowNull: false },
          route_kind: { type: DataTypes.STRING(12), allowNull: false },
          device_class: { type: DataTypes.STRING(8), allowNull: false },
          created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
        },
        { transaction }
      );
      const check = async (name, sql) => {
        await queryInterface.sequelize.query(`ALTER TABLE store_web_vitals DROP CONSTRAINT IF EXISTS ${name}`, { transaction });
        await queryInterface.sequelize.query(`ALTER TABLE store_web_vitals ADD CONSTRAINT ${name} CHECK (${sql})`, { transaction });
      };
      await check('store_web_vitals_metric_check', `metric IN (${list(METRICS)})`);
      await check('store_web_vitals_route_kind_check', `route_kind IN (${list(ROUTES)})`);
      await check('store_web_vitals_device_class_check', `device_class IN (${list(DEVICES)})`);
      await queryInterface.addIndex('store_web_vitals', ['workspace_id', 'metric', 'created_at'], { name: 'store_web_vitals_ws_metric_created_idx', transaction });
      await queryInterface.addIndex('store_web_vitals', ['created_at'], { name: 'store_web_vitals_created_at_idx', transaction });
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('store_web_vitals');
  },
};
