'use strict';

const { withLockTimeout, constraintExists } = require('../lockTimeout');

/**
 * What a store sells, asked on the store setup step (optional; the list is in
 * modules/workspaces/businessTypes.js and shown read-only in the console).
 *
 * workspaces
 *   business_type        VARCHAR(32), nullable, no default: old stores stay
 *                        null. CHECK against the list below (added NOT VALID,
 *                        then validated, so no long lock on the table).
 *   business_type_other  VARCHAR(80), nullable: the merchant's words when the
 *                        type is "other".
 *
 * Each step runs under a lock_timeout with retries (db/lockTimeout.js): every
 * request reads this table. Run-twice safe. Down drops the constraint and both
 * columns (their values are lost).
 */

const CHECK = 'workspaces_business_type_check';
const TYPES = ['fashion', 'electronics', 'beauty', 'food', 'home', 'accessories', 'kids', 'sports', 'services', 'other'];
const list = TYPES.map((t) => `'${t}'`).join(', ');

module.exports = {
  up: async (queryInterface) => {
    const { sequelize } = queryInterface;
    await withLockTimeout(sequelize, async (transaction) => {
      await sequelize.query('ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS business_type VARCHAR(32)', { transaction });
      await sequelize.query('ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS business_type_other VARCHAR(80)', { transaction });
      if (!(await constraintExists(sequelize, CHECK, transaction))) {
        await sequelize.query(
          `ALTER TABLE workspaces ADD CONSTRAINT ${CHECK} CHECK (business_type IS NULL OR business_type IN (${list})) NOT VALID`,
          { transaction }
        );
      }
    });
    await withLockTimeout(sequelize, (transaction) =>
      sequelize.query(`ALTER TABLE workspaces VALIDATE CONSTRAINT ${CHECK}`, { transaction })
    );
  },

  down: async (queryInterface) => {
    const { sequelize } = queryInterface;
    await withLockTimeout(sequelize, async (transaction) => {
      await sequelize.query(`ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS ${CHECK}`, { transaction });
      await sequelize.query('ALTER TABLE workspaces DROP COLUMN IF EXISTS business_type_other', { transaction });
      await sequelize.query('ALTER TABLE workspaces DROP COLUMN IF EXISTS business_type', { transaction });
    });
  },
};
