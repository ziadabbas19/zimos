'use strict';

module.exports = (sequelize, DataTypes) => {
  // Backs both email verification and password reset. Only the SHA-256 hash
  // of the token is stored; the raw token is emailed/SMS'd once and never
  // persisted. `usedAt` makes tokens single-use.
  const VerificationToken = sequelize.define(
    'VerificationToken',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
      type: { type: DataTypes.ENUM('email_verification', 'password_reset'), allowNull: false },
      tokenHash: { type: DataTypes.STRING(64), allowNull: false, field: 'token_hash' },
      expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
      usedAt: { type: DataTypes.DATE, allowNull: true, field: 'used_at' },
    },
    {
      tableName: 'verification_tokens',
      indexes: [{ unique: true, fields: ['token_hash'] }, { fields: ['user_id', 'type'] }],
    }
  );

  VerificationToken.associate = (models) => {
    VerificationToken.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
  };

  return VerificationToken;
};
