'use strict';

module.exports = (sequelize, DataTypes) => {
  // Only the SHA-256 hash of the refresh token is stored (see
  // core/security/tokens.js). `rotatedToSessionId` links a session to the
  // session that replaced it after a rotation, forming an audit chain that
  // lets us detect refresh-token reuse (a strong signal of theft) and revoke
  // the whole chain.
  const Session = sequelize.define(
    'Session',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      userId: { type: DataTypes.UUID, allowNull: false, field: 'user_id' },
      refreshTokenHash: { type: DataTypes.STRING(64), allowNull: false, unique: true, field: 'refresh_token_hash' },
      userAgent: { type: DataTypes.STRING(500), allowNull: true, field: 'user_agent' },
      ipAddress: { type: DataTypes.STRING(64), allowNull: true, field: 'ip_address' },
      expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
      revokedAt: { type: DataTypes.DATE, allowNull: true, field: 'revoked_at' },
      rotatedToSessionId: { type: DataTypes.UUID, allowNull: true, field: 'rotated_to_session_id' },
    },
    {
      tableName: 'sessions',
      indexes: [{ fields: ['user_id'] }, { unique: true, fields: ['refresh_token_hash'] }],
    }
  );

  Session.associate = (models) => {
    Session.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
  };

  Session.prototype.isActive = function isActive() {
    return !this.revokedAt && this.expiresAt > new Date();
  };

  return Session;
};
