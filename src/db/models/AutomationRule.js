'use strict';

module.exports = (sequelize, DataTypes) => {
  // Simple event -> condition -> action model. `trigger` names an event key
  // (e.g. "order.confirmed"); `conditions` is a small JSON expression tree
  // evaluated against the event payload; `actions` is an ordered list of
  // { type, config } steps executed by modules/automations/actionRunners/*.
  const AutomationRule = sequelize.define(
    'AutomationRule',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      name: { type: DataTypes.STRING(200), allowNull: false },
      trigger: { type: DataTypes.STRING(100), allowNull: false },
      conditions: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      actions: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' },
    },
    { tableName: 'automation_rules', indexes: [{ fields: ['workspace_id', 'trigger'] }] }
  );
  return AutomationRule;
};
