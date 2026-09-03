'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('template_versions', {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        allowNull: false,
      },
      template_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'templates', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      version: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      global_styles: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      pages: {
        type: DataTypes.JSONB,
        defaultValue: [],
        allowNull: false,
      },
      sections: {
        type: DataTypes.JSONB,
        defaultValue: [],
        allowNull: false,
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('template_versions', ["template_id","version"], { unique: true, name: 'template_versions_template_id_version_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('template_versions');
  },
};
