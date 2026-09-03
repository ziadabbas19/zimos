'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('offer_variants', {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
        allowNull: false,
      },
      offer_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'offers', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      variant_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'product_variants', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      },
      quantity: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
        allowNull: false,
      },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    });

    await queryInterface.addIndex('offer_variants', ["offer_id"], { unique: false, name: 'offer_variants_offer_id_idx' });
    await queryInterface.addIndex('offer_variants', ["variant_id"], { unique: false, name: 'offer_variants_variant_id_idx' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('offer_variants');
  },
};
