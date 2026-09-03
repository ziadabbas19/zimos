'use strict';

module.exports = (sequelize, DataTypes) => {
  const OfferVariant = sequelize.define(
    'OfferVariant',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      offerId: { type: DataTypes.UUID, allowNull: false, field: 'offer_id' },
      variantId: { type: DataTypes.UUID, allowNull: false, field: 'variant_id' },
      quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, validate: { min: 1 } },
    },
    { tableName: 'offer_variants', indexes: [{ fields: ['offer_id'] }, { fields: ['variant_id'] }] }
  );

  OfferVariant.associate = (models) => {
    OfferVariant.belongsTo(models.Offer, { foreignKey: 'offerId', as: 'offer' });
    OfferVariant.belongsTo(models.ProductVariant, { foreignKey: 'variantId', as: 'variant' });
  };

  return OfferVariant;
};
