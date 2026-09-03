'use strict';

module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define(
    'User',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      email: {
        type: DataTypes.CITEXT,
        allowNull: false,
        unique: true,
        validate: { isEmail: true },
      },
      passwordHash: { type: DataTypes.STRING, allowNull: true, field: 'password_hash' },
      googleId: { type: DataTypes.STRING(64), allowNull: true, unique: true, field: 'google_id' },
      fullName: { type: DataTypes.STRING(200), allowNull: false, field: 'full_name' },
      phone: { type: DataTypes.STRING(32), allowNull: true },
      status: {
        type: DataTypes.ENUM('active', 'suspended', 'pending_verification'),
        allowNull: false,
        defaultValue: 'pending_verification',
      },
      emailVerifiedAt: { type: DataTypes.DATE, allowNull: true, field: 'email_verified_at' },
      phoneVerifiedAt: { type: DataTypes.DATE, allowNull: true, field: 'phone_verified_at' },
      lastLoginAt: { type: DataTypes.DATE, allowNull: true, field: 'last_login_at' },
      // Global platform-admin flag (not a full role system).
      platformAdmin: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'platform_admin' },
    },
    {
      tableName: 'users',
      indexes: [{ unique: true, fields: ['email'] }],
    }
  );

  User.associate = (models) => {
    User.hasMany(models.Membership, { foreignKey: 'userId', as: 'memberships' });
    User.hasMany(models.Session, { foreignKey: 'userId', as: 'sessions' });
    User.hasMany(models.Workspace, { foreignKey: 'ownerUserId', as: 'ownedWorkspaces' });
  };

  // Never serialize the password hash.
  User.prototype.toSafeJSON = function toSafeJSON() {
    const { passwordHash, ...rest } = this.toJSON();
    return rest;
  };

  return User;
};
