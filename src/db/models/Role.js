'use strict';

module.exports = (sequelize, DataTypes) => {
  // System roles (Owner, Workspace Manager, Editor, Order Operator,
  // Confirmation Agent, Accountant) are seeded per-workspace at workspace
  // creation time with isSystem=true and cannot be deleted. Workspaces can
  // also define custom roles with an arbitrary permission set drawn from the
  // canonical list in core/security/permissions.js.
  const Role = sequelize.define(
    'Role',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      key: { type: DataTypes.STRING(64), allowNull: false },
      name: { type: DataTypes.STRING(100), allowNull: false },
      isSystem: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_system' },
      permissions: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
    },
    {
      tableName: 'roles',
      indexes: [{ unique: true, fields: ['workspace_id', 'key'] }],
    }
  );

  Role.associate = (models) => {
    Role.belongsTo(models.Workspace, { foreignKey: 'workspaceId', as: 'workspace' });
    Role.hasMany(models.Membership, { foreignKey: 'roleId', as: 'memberships' });
  };

  return Role;
};
