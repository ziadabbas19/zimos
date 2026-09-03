'use strict';

/**
 * Immutable numbered snapshot-per-publish for funnels, mirroring
 * website_revisions. Also repoints funnels.published_revision_id at this new
 * table — migration 058 had it pointing at website_revisions by mistake.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;

    await queryInterface.createTable('funnel_revisions', {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        allowNull: false,
      },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      funnel_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'funnels', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      revision_number: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      // { funnel: {...}, steps: [...], edges: [...] } frozen at publish time.
      snapshot: {
        type: DataTypes.JSONB,
        allowNull: false,
      },
      published_by_user_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      },
      note: {
        type: DataTypes.STRING(300),
        allowNull: true,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });

    await queryInterface.addIndex('funnel_revisions', ['funnel_id'], {
      unique: false,
      name: 'funnel_revisions_funnel_id_idx',
    });
    await queryInterface.addIndex('funnel_revisions', ['funnel_id', 'revision_number'], {
      unique: true,
      name: 'funnel_revisions_funnel_id_revision_number_uidx',
    });

    // Repoint funnels.published_revision_id -> funnel_revisions(id).
    await queryInterface.removeConstraint('funnels', 'funnels_published_revision_id_fkey');
    await queryInterface.addConstraint('funnels', {
      fields: ['published_revision_id'],
      type: 'foreign key',
      name: 'funnels_published_revision_id_fkey',
      references: { table: 'funnel_revisions', field: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeConstraint('funnels', 'funnels_published_revision_id_fkey');
    await queryInterface.dropTable('funnel_revisions');
    // Restore the (incorrect, but original) constraint so `down` is a true inverse.
    await queryInterface.addConstraint('funnels', {
      fields: ['published_revision_id'],
      type: 'foreign key',
      name: 'funnels_published_revision_id_fkey',
      references: { table: 'website_revisions', field: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });
  },
};
