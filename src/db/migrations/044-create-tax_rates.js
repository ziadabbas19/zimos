'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('tax_rates', {
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
      name: {
        type: DataTypes.STRING(150),
        allowNull: false,
      },
      country: {
        type: DataTypes.STRING(2),
        allowNull: true,
      },
      region: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      rate_basis_points: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      applies_to_shipping: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      prices_include_tax: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      product_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'products', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('tax_rates', ["workspace_id"], { unique: false, name: 'tax_rates_workspace_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('tax_rates');
  },
};
