'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Two additions to a creator's review of referral codes (migration 742):
 *
 *   referral_codes.review_authors   who changed what is waiting for review, so
 *     that nobody but a creator reviews their own change.
 *
 *   agent_link_requests   a change to which agent earns on a store, asked for by
 *     anyone but a creator: 'link' (link the store, or move it to another
 *     agent), 'update' or 'end'. It is a table of its own and not a row in
 *     agent_links, so nothing that reads a link (commissions above all) can see
 *     a change nobody approved: the link as it stands goes on earning until
 *     then. One waiting per store.
 *
 * Run-twice safe (every step guarded). down removes everything added here: a
 * change still waiting is lost, and the link goes on as it stands.
 */

const CHECK = 'agent_link_requests_check';
const ONE_WAITING = 'agent_link_requests_one_pending_per_store';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    const user = () => ({ type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE' });

    await qi.addColumn('referral_codes', 'review_authors', { type: DataTypes.JSONB, allowNull: false, defaultValue: [] });

    await qi.createTable('agent_link_requests', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()'), allowNull: false },
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      agent_link_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'agent_links', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      kind: { type: DataTypes.STRING(10), allowNull: false },
      changes: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
      reason: { type: DataTypes.TEXT, allowNull: true },
      requested_by_user_id: user(),
      reviewed_by_user_id: user(),
      reviewed_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.sequelize.query(`ALTER TABLE agent_link_requests DROP CONSTRAINT IF EXISTS ${CHECK}`);
    await queryInterface.sequelize.query(
      `ALTER TABLE agent_link_requests ADD CONSTRAINT ${CHECK} CHECK (
         kind IN ('link', 'update', 'end')
         AND status IN ('pending', 'approved', 'rejected')
         AND (kind = 'link' OR agent_link_id IS NOT NULL)
       )`
    );
    await qi.addIndex('agent_link_requests', ['workspace_id'], { name: ONE_WAITING, unique: true, where: { status: 'pending' } });
  },
  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await queryInterface.dropTable('agent_link_requests');
    await qi.removeColumn('referral_codes', 'review_authors');
  },
};
