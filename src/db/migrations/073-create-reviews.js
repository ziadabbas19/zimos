'use strict';

/**
 * Product reviews. A shopper (matched by phone to a Customer) may leave one
 * review per product, only after a delivered order that contained it. Reviews
 * start `pending` and are shown on the storefront only once staff approve.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('reviews', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      product_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'products', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      customer_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'customers', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      order_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'orders', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      rating: { type: DataTypes.INTEGER, allowNull: false },
      comment: { type: DataTypes.TEXT, allowNull: true },
      status: {
        type: DataTypes.ENUM('pending', 'approved', 'rejected'),
        allowNull: false,
        defaultValue: 'pending',
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });

    await queryInterface.addIndex('reviews', ['workspace_id', 'product_id', 'customer_id'], {
      unique: true,
      name: 'reviews_workspace_product_customer_uidx',
    });
    await queryInterface.addIndex('reviews', ['workspace_id', 'product_id', 'status'], {
      name: 'reviews_workspace_product_status_idx',
    });
    await queryInterface.addIndex('reviews', ['workspace_id', 'status'], { name: 'reviews_workspace_status_idx' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('reviews');
  },
};
