'use strict';

const { guarded } = require('../migrationGuards');

/**
 * What a visit was, kept on its session row (analytics/traffic/visitorDetails.js,
 * TRAFFIC_DETAILS_ENABLED; nothing is written here while it is off), so the
 * visitors screens read sessions — far fewer rows than events — by index.
 *
 * analytics_sessions
 *   detailed             written by this code (older rows are left out of
 *                        the visitors screens rather than shown half empty)
 *   source … utm_term    the visit's UTM values, from its first page or the
 *                        tracker's first-touch attribution
 *   referrer_domain      the external site it came from
 *   landing_path         its first page
 *   has_gclid/fbclid/ttclid  whether it arrived with an ad click id (only
 *                        that it did: the id itself is not kept)
 *   governorate          one of the 27 codes of shipping/governorates.js
 *   governorate_approx   the same from the IP's region (Cloudflare), never
 *                        overwritten
 *   geo_source           ip_approx | order_address (the province the
 *                        shopper typed on their order replaced it)
 *   page_views           pages it viewed
 *   reached_product / reached_cart / reached_checkout / ordered
 *                        the funnel steps it reached (ordered: a purchase of
 *                        a real order of the store)
 *   last_order_id        that order
 *
 * analytics_events (and analytics_quarantine_events, which mirrors it)
 *   dwell_ms             visible time on this page view, from the tracker's
 *                        reports (the page was on screen; hidden time is not counted)
 *   product_id           the product the page showed, for time per product
 *
 * Additive and run-twice safe, without a transaction: every column is
 * nullable or has a constant default (no table rewrite), and the three
 * indexes on analytics_sessions are built CONCURRENTLY.
 */

const GEO_SOURCES = ['ip_approx', 'order_address'];

const SESSION_INDEXES = [
  // The merchant's screens: a store's detailed sessions in a period.
  ['analytics_sessions_detailed_ws_created_idx', ['workspace_id', 'created_at'], true],
  // The console's: every store's detailed sessions in a period.
  ['analytics_sessions_detailed_created_idx', ['created_at'], true],
  // An order replaces the governorate of every session of its visitor.
  ['analytics_sessions_ws_visitor_idx', ['workspace_id', 'visitor_id'], false],
];

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    const str = (n) => ({ type: DataTypes.STRING(n), allowNull: true });
    const flag = { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false };

    const sessionColumns = {
      detailed: flag,
      source: str(100),
      medium: str(100),
      campaign: str(150),
      utm_content: str(255),
      utm_term: str(255),
      referrer_domain: str(255),
      landing_path: str(500),
      has_gclid: flag,
      has_fbclid: flag,
      has_ttclid: flag,
      governorate: str(30),
      governorate_approx: str(30),
      geo_source: str(20),
      page_views: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      reached_product: flag,
      reached_cart: flag,
      reached_checkout: flag,
      ordered: flag,
      last_order_id: { type: DataTypes.UUID, allowNull: true },
    };
    for (const [name, def] of Object.entries(sessionColumns)) await qi.addColumn('analytics_sessions', name, def);
    const [checks] = await queryInterface.sequelize.query("SELECT 1 FROM pg_constraint WHERE conname = 'analytics_sessions_geo_source_check'");
    if (checks.length === 0) {
      await queryInterface.sequelize.query(
        `ALTER TABLE analytics_sessions ADD CONSTRAINT analytics_sessions_geo_source_check
           CHECK (geo_source IS NULL OR geo_source IN (${GEO_SOURCES.map((s) => `'${s}'`).join(', ')}))`
      );
    }

    for (const table of ['analytics_events', 'analytics_quarantine_events']) {
      const [[present]] = await queryInterface.sequelize.query('SELECT to_regclass(:name) AS oid', { replacements: { name: `public.${table}` } });
      if (!present.oid) continue;
      await qi.addColumn(table, 'dwell_ms', { type: DataTypes.INTEGER, allowNull: true });
      await qi.addColumn(table, 'product_id', { type: DataTypes.UUID, allowNull: true });
    }

    for (const [name, fields, detailedOnly] of SESSION_INDEXES) {
      await qi.addIndex('analytics_sessions', fields, { name, ...(detailedOnly ? { where: { detailed: true } } : {}) });
    }
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    for (const [name] of SESSION_INDEXES) await queryInterface.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
    for (const table of ['analytics_quarantine_events', 'analytics_events']) {
      await qi.removeColumn(table, 'product_id');
      await qi.removeColumn(table, 'dwell_ms');
    }
    await queryInterface.sequelize.query('ALTER TABLE analytics_sessions DROP CONSTRAINT IF EXISTS analytics_sessions_geo_source_check');
    const columns = [
      'last_order_id',
      'ordered',
      'reached_checkout',
      'reached_cart',
      'reached_product',
      'page_views',
      'geo_source',
      'governorate_approx',
      'governorate',
      'has_ttclid',
      'has_fbclid',
      'has_gclid',
      'landing_path',
      'referrer_domain',
      'utm_term',
      'utm_content',
      'campaign',
      'medium',
      'source',
      'detailed',
    ];
    for (const column of columns) await qi.removeColumn('analytics_sessions', column);
  },
};
