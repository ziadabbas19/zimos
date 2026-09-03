'use strict';

module.exports = (sequelize, DataTypes) => {
  const Cart = sequelize.define(
    'Cart',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      websiteId: { type: DataTypes.UUID, allowNull: true, field: 'website_id' },
      funnelId: { type: DataTypes.UUID, allowNull: true, field: 'funnel_id' },
      customerId: { type: DataTypes.UUID, allowNull: true, field: 'customer_id' },
      // Guest carts are tracked by an opaque token stored client-side (cookie/localStorage)
      // and merged into the customer's cart on login.
      guestToken: { type: DataTypes.STRING(64), allowNull: true, field: 'guest_token' },
      currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'EGP' },
      status: {
        type: DataTypes.ENUM('active', 'converted', 'abandoned', 'merged'),
        allowNull: false,
        defaultValue: 'active',
      },
      attribution: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    },
    {
      tableName: 'carts',
      indexes: [{ fields: ['workspace_id', 'guest_token'] }, { fields: ['workspace_id', 'customer_id'] }],
    }
  );

  Cart.associate = (models) => {
    Cart.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    Cart.belongsTo(models.Customer, { foreignKey: 'customerId', as: 'customer' });
    Cart.hasMany(models.CartItem, { foreignKey: 'cartId', as: 'items' });
  };

  return Cart;
};
