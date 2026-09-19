'use strict';

/**
 * Gallery fields for the template picker. The new gallery puts store themes,
 * funnels and landing pages side by side in one grid, so each card has to say
 * what kind of thing it is, what it costs, which colour it leads with and
 * which direction it reads — without the list endpoint loading every
 * template's active version to find out.
 *
 * `primary_color` is denormalized from the active version's
 * `global_styles.primaryColor` (backfilled below) purely so the grid can paint
 * a swatch from one query; the version stays the source of truth for the
 * styles actually copied into a merchant's site.
 *
 * `price_amount` is in minor units like every other money column, and
 * `is_free` is stored rather than derived from it so a paid template can be
 * given away for a while without losing its list price.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const { DataTypes } = Sequelize;

    await queryInterface.addColumn('templates', 'kind', {
      type: DataTypes.ENUM('store', 'funnel', 'landing'),
      allowNull: false,
      defaultValue: 'store',
    });
    await queryInterface.addColumn('templates', 'price_amount', {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.addColumn('templates', 'is_free', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });
    await queryInterface.addColumn('templates', 'primary_color', {
      type: DataTypes.STRING(20),
      allowNull: true,
    });
    await queryInterface.addColumn('templates', 'tags', {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: false,
      defaultValue: [],
    });
    // Every template shipped so far is Arabic, so `true` is the default that
    // leaves the existing rows correct.
    await queryInterface.addColumn('templates', 'rtl', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });

    // Backfill the swatch from the highest active version of each template.
    await queryInterface.sequelize.query(`
      UPDATE templates t
      SET primary_color = sub.color
      FROM (
        SELECT DISTINCT ON (template_id)
               template_id,
               global_styles->>'primaryColor' AS color
        FROM template_versions
        WHERE is_active = true
        ORDER BY template_id, version DESC
      ) sub
      WHERE sub.template_id = t.id
        AND sub.color IS NOT NULL
        AND char_length(sub.color) <= 20
    `);
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('templates', 'rtl');
    await queryInterface.removeColumn('templates', 'tags');
    await queryInterface.removeColumn('templates', 'primary_color');
    await queryInterface.removeColumn('templates', 'is_free');
    await queryInterface.removeColumn('templates', 'price_amount');
    await queryInterface.removeColumn('templates', 'kind');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_templates_kind";');
  },
};
