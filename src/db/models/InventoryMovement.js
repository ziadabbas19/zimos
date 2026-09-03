'use strict';

module.exports = (sequelize, DataTypes) => {
  const InventoryMovement = sequelize.define(
    'InventoryMovement',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      variantId: { type: DataTypes.UUID, allowNull: false, field: 'variant_id' },
      type: {
        type: DataTypes.ENUM(
          'restock',
          'adjustment',
          'reserve',
          'release',
          'commit', // reservation -> permanent deduction (order confirmed/shipped, per workspace policy)
          'return_restock'
        ),
        allowNull: false,
      },
      quantityDelta: { type: DataTypes.INTEGER, allowNull: false, field: 'quantity_delta' },
      reservedDelta: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'reserved_delta' },
      reason: { type: DataTypes.STRING(300), allowNull: true },
      referenceType: { type: DataTypes.STRING(100), allowNull: true, field: 'reference_type' },
      referenceId: { type: DataTypes.STRING(100), allowNull: true, field: 'reference_id' },
      actorUserId: { type: DataTypes.UUID, allowNull: true, field: 'actor_user_id' },
    },
    {
      tableName: 'inventory_movements',
      updatedAt: false,
      indexes: [{ fields: ['workspace_id', 'variant_id'] }, { fields: ['reference_type', 'reference_id'] }],
    }
  );

  InventoryMovement.associate = (models) => {
    InventoryMovement.belongsTo(models.ProductVariant, { foreignKey: 'variantId', as: 'variant' });
  };

  return InventoryMovement;
};
