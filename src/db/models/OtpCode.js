'use strict';

module.exports = (sequelize, DataTypes) => {
  // Generic one-time SMS codes. The raw code is never stored — only
  // `codeHash` (sha256). `attempts` caps brute force per code; `consumedAt`
  // makes a successful verification single-use. See modules/otp/otpService.js.
  const OtpCode = sequelize.define(
    'OtpCode',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      phone: { type: DataTypes.STRING(32), allowNull: false },
      purpose: { type: DataTypes.STRING(50), allowNull: false },
      codeHash: { type: DataTypes.STRING(128), allowNull: false, field: 'code_hash' },
      expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      consumedAt: { type: DataTypes.DATE, allowNull: true, field: 'consumed_at' },
    },
    {
      tableName: 'otp_codes',
      indexes: [
        { fields: ['phone', 'purpose'] },
        { fields: ['phone', 'created_at'] },
      ],
    }
  );

  return OtpCode;
};
