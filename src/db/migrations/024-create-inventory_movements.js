'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('inventory_movements', {
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
      variant_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'product_variants', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      type: {
        type: DataTypes.ENUM('restock', 'adjustment', 'reserve', 'release', 'commit', 'return_restock'),
        allowNull: false,
      },
      quantity_delta: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      reserved_delta: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      reason: {
        type: DataTypes.STRING(300),
        allowNull: true,
      },
      reference_type: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      reference_id: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      actor_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('inventory_movements', ["workspace_id","variant_id"], { unique: false, name: 'inventory_movements_workspace_id_variant_id_idx' });
    await queryInterface.addIndex('inventory_movements', ["reference_type","reference_id"], { unique: false, name: 'inventory_movements_reference_type_reference_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('inventory_movements');
  },
};
