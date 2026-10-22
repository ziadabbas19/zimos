'use strict';

/**
 * The platform's own public details, edited in the console's "Platform
 * settings" (modules/platformSettings): how to reach ZIMOS, its social
 * accounts, the company details, the marketing footer's words and the system
 * emails' sender name and signature. A new table only: nothing existing
 * changes, and nothing reads it while PLATFORM_SETTINGS_ENABLED is off.
 *
 * platform_settings
 *   one row per group, written whole on each save:
 *     key         contact | social | company | footer | email
 *     value       the group's fields (JSONB), checked by the service before
 *                 it is written; never a secret (the service refuses one)
 *     updated_by  the account that saved it last (no foreign key: the audit
 *                 log names the actor of every change, and a launch reset
 *                 deletes accounts while this table is kept)
 *   No row = the group was never saved: the sites show the values written
 *   in their code, as before this table existed.
 *
 * Every change (old value, new value, who, when) is in audit_logs
 * (entity_type 'platform_setting', entity_id = the key).
 *
 * Written to be harmless if it runs again. Down drops the table: the sites
 * go back to the values in their code; the audit log keeps the history.
 */

const KEYS = ['contact', 'social', 'company', 'footer', 'email'];
const list = (values) => values.map((v) => `'${v}'`).join(', ');

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        key VARCHAR(32) PRIMARY KEY CONSTRAINT platform_settings_key_check CHECK (key IN (${list(KEYS)})),
        value JSONB NOT NULL,
        updated_by UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS platform_settings');
  },
};
