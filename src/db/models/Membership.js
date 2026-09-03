'use strict';

module.exports = (sequelize, DataTypes) => {
  const Membership = sequelize.define(
    'Membership',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      // Null until a pending invite (status 'invited', keyed on invitedEmail)
      // is accepted and linked to a real user account.
      userId: { type: DataTypes.UUID, allowNull: true, field: 'user_id' },
      roleId: { type: DataTypes.UUID, allowNull: false, field: 'role_id' },
      status: {
        type: DataTypes.ENUM('active', 'invited', 'suspended'),
        allowNull: false,
        defaultValue: 'active',
      },
      invitedEmail: { type: DataTypes.STRING, allowNull: true, field: 'invited_email' },
    },
    {
      tableName: 'memberships',
      indexes: [
        { unique: true, fields: ['workspace_id', 'user_id'] },
        { fields: ['user_id'] },
      ],
    }
  );

  Membership.associate = (models) => {
    Membership.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    Membership.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
    Membership.belongsTo(models.Role, { foreignKey: 'roleId', as: 'role' });
  };

  return Membership;
};
