'use strict';

/**
 * The five seeded templates shipped with thumbnail URLs under
 * https://media.zimos.co/templates/ — a host that never served those files.
 * Every gallery card has been rendering a broken image ever since.
 *
 * NULL is the honest value: the gallery already has to handle a template with
 * no screenshot yet (anything created through /admin/templates starts that
 * way), so clearing these puts the seeded rows on that same path until real
 * screenshots exist. The seeder no longer sets them either — this migration is
 * for the rows production already has.
 *
 * Scoped by the URL prefix so a thumbnail an admin has since uploaded is left
 * alone.
 */
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `UPDATE templates SET thumbnail_url = NULL, updated_at = NOW()
        WHERE thumbnail_url LIKE 'https://media.zimos.co/templates/%'`
    );
  },

  // Deliberately a no-op: putting the broken URLs back would only restore the
  // broken images, and the originals are not recoverable from NULL anyway.
  down: async () => {},
};
