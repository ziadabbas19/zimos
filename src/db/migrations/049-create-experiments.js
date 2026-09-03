'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('experiments', {
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
      subject_type: {
        type: DataTypes.ENUM('website_page', 'funnel_step'),
        allowNull: false,
      },
      subject_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      name: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      variants: {
        type: DataTypes.JSONB,
        defaultValue: [],
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('running', 'paused', 'completed'),
        defaultValue: "running",
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('experiments', ["workspace_id","subject_type","subject_id"], { unique: false, name: 'experiments_workspace_id_subject_type_subject_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('experiments');
  },
};
