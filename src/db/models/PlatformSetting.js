'use strict';

// One group of the platform's public details (migration 706). Read and
// written only by modules/platformSettings/platformSettingsService.
module.exports = (sequelize, DataTypes) => {
  const PlatformSetting = sequelize.define(
    'PlatformSetting',
    {
      key: { type: DataTypes.STRING(32), primaryKey: true },
      value: { type: DataTypes.JSONB, allowNull: false },
      updatedBy: { type: DataTypes.UUID, allowNull: true, field: 'updated_by' },
    },
    { tableName: 'platform_settings' }
  );
  return PlatformSetting;
};
