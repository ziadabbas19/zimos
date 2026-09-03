'use strict';

/**
 * Give WebsiteRevision rows a stable per-website sequence number ("restore to
 * revision 3"). Added nullable, backfilled by creation order, then set NOT
 * NULL with a unique (website_id, revision_number) index.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;

    await queryInterface.addColumn('website_revisions', 'revision_number', {
      type: DataTypes.INTEGER,
      allowNull: true,
    });

    await queryInterface.sequelize.query(`
      UPDATE website_revisions AS wr
      SET revision_number = sub.rn
      FROM (
        SELECT id, row_number() OVER (PARTITION BY website_id ORDER BY created_at, id) AS rn
        FROM website_revisions
      ) AS sub
      WHERE wr.id = sub.id;
    `);

    await queryInterface.changeColumn('website_revisions', 'revision_number', {
      type: DataTypes.INTEGER,
      allowNull: false,
    });

    await queryInterface.addIndex('website_revisions', ['website_id', 'revision_number'], {
      unique: true,
      name: 'website_revisions_website_id_revision_number_uidx',
    });
  },
  down: async (queryInterface) => {
    await queryInterface.removeIndex('website_revisions', 'website_revisions_website_id_revision_number_uidx');
    await queryInterface.removeColumn('website_revisions', 'revision_number');
  },
};
