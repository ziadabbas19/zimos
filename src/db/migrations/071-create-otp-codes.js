'use strict';

/**
 * Generic one-time codes for SMS verification flows (phone verification,
 * password reset by SMS, and anything added later). Only a hash of the code
 * is stored, never the raw digits.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;
    await queryInterface.createTable('otp_codes', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4, allowNull: false },
      phone: { type: DataTypes.STRING(32), allowNull: false },
      purpose: { type: DataTypes.STRING(50), allowNull: false },
      code_hash: { type: DataTypes.STRING(128), allowNull: false },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      consumed_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });

    await queryInterface.addIndex('otp_codes', ['phone', 'purpose'], { name: 'otp_codes_phone_purpose_idx' });
    await queryInterface.addIndex('otp_codes', ['phone', 'created_at'], { name: 'otp_codes_phone_created_at_idx' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('otp_codes');
  },
};
