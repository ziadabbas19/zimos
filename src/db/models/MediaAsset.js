'use strict';

module.exports = (sequelize, DataTypes) => {
  // One row per uploaded file — the media library behind the builder's image
  // picker. `path` is the storage key (what the backend deletes by), `url` the
  // public address page trees embed. See modules/media/mediaService.js.
  const MediaAsset = sequelize.define(
    'MediaAsset',
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      workspaceId: { type: DataTypes.UUID, allowNull: false, field: 'workspace_id' },
      uploadedByUserId: { type: DataTypes.UUID, allowNull: true, field: 'uploaded_by_user_id' },
      url: { type: DataTypes.STRING(1000), allowNull: false },
      path: { type: DataTypes.STRING(1000), allowNull: false },
      mimeType: { type: DataTypes.STRING(100), allowNull: false, field: 'mime_type' },
      sizeBytes: { type: DataTypes.INTEGER, allowNull: false, field: 'size_bytes' },
    },
    {
      tableName: 'media_assets',
      indexes: [{ fields: ['workspace_id', 'created_at', 'id'] }],
    }
  );

  MediaAsset.associate = (models) => {
    MediaAsset.belongsTo(models.User, { foreignKey: 'uploadedByUserId', as: 'uploadedBy' });
  };

  return MediaAsset;
};
