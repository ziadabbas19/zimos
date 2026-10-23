'use strict';

const db = require('../../../db/models');
const env = require('../../../config/env');
const { guardEnabled, originMode, storeDailyCap } = require('./guardConfig');

/**
 * The console's view of what the events guard kept out (GET
 * /admin/store-traffic/protection): counts per kind, reason, source (bot
 * family, origin host, hashed IP), country and store, per UTC day, from
 * traffic_filter_days; the stores that went over their daily cap
 * (traffic_store_days); and the latest flagged sessions. Read-only.
 *
 * Kept 30 days (traffic/purge.js), so a range is at most that. Days are
 * UTC days, as the counters write them.
 *
 * `scope` is store (the storefront events endpoint, the default) or site (the
 * marketing site's beacon, siteAnalytics/): the site has no stores, no daily
 * cap and no flagged sessions, so those lists come back empty for it.
 */

const RANGES = { today: 1, '7d': 7, '30d': 30 };
const TOP = 20;

const toNumber = (v) => (v === null || v === undefined ? 0 : Number(v));
const query = (sql, replacements) => db.sequelize.query(sql, { replacements, type: db.Sequelize.QueryTypes.SELECT });

async function summary({ range = '7d', workspaceId = null, scope = 'store' } = {}) {
  const days = RANGES[range] || 7;
  const site = scope === 'site';
  const replacements = { days: days - 1, workspaceId, scope: site ? 'site' : 'store' };
  const where = `f.day >= (now() AT TIME ZONE 'UTC')::date - CAST(:days AS integer) AND f.scope = :scope${
    workspaceId && !site ? ' AND f.workspace_id = :workspaceId' : ''
  }`;
  const pivot = `
      coalesce(sum(f.count) FILTER (WHERE f.kind = 'bot'), 0) AS bot,
      coalesce(sum(f.count) FILTER (WHERE f.kind = 'rejected'), 0) AS rejected,
      coalesce(sum(f.count) FILTER (WHERE f.kind = 'suspicious'), 0) AS suspicious,
      coalesce(sum(f.count) FILTER (WHERE f.kind = 'capped'), 0) AS capped`;
  const counts = (r) => ({ bot: toNumber(r.bot), rejected: toNumber(r.rejected), suspicious: toNumber(r.suspicious), capped: toNumber(r.capped) });

  const [[totals], byReason, bySource, byCountry, byStore, daily, capped, flagged] = await Promise.all([
    query(`SELECT ${pivot} FROM traffic_filter_days f WHERE ${where}`, replacements),
    query(
      `SELECT f.kind, f.reason, sum(f.count) AS count FROM traffic_filter_days f WHERE ${where}
        GROUP BY 1, 2 ORDER BY 3 DESC`,
      replacements
    ),
    query(
      `SELECT f.kind, f.reason, f.label, sum(f.count) AS count FROM traffic_filter_days f WHERE ${where} AND f.label <> ''
        GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT ${TOP}`,
      replacements
    ),
    query(
      `SELECT nullif(f.country, '') AS country, ${pivot} FROM traffic_filter_days f WHERE ${where}
        GROUP BY 1 ORDER BY sum(f.count) DESC LIMIT ${TOP}`,
      replacements
    ),
    query(
      `SELECT f.workspace_id AS "workspaceId", w.name, w.slug, ${pivot}
         FROM traffic_filter_days f LEFT JOIN workspaces w ON w.id = f.workspace_id
        WHERE ${where}
        GROUP BY 1, 2, 3 ORDER BY sum(f.count) DESC LIMIT ${TOP}`,
      replacements
    ),
    query(`SELECT to_char(f.day, 'YYYY-MM-DD') AS day, ${pivot} FROM traffic_filter_days f WHERE ${where} GROUP BY 1 ORDER BY 1`, replacements),
    site
      ? []
      : query(
          `SELECT d.workspace_id AS "workspaceId", w.name, w.slug, to_char(d.day, 'YYYY-MM-DD') AS day,
                  d.stored_events AS stored, d.overflow_events AS overflow, d.cap_reached_at AS "capReachedAt"
             FROM traffic_store_days d JOIN workspaces w ON w.id = d.workspace_id
            WHERE d.day >= (now() AT TIME ZONE 'UTC')::date - CAST(:days AS integer) AND d.cap_reached_at IS NOT NULL
                  ${workspaceId ? 'AND d.workspace_id = :workspaceId' : ''}
            ORDER BY d.day DESC, d.overflow_events DESC LIMIT 50`,
          replacements
        ),
    site
      ? []
      : query(
          `SELECT s.workspace_id AS "workspaceId", w.name AS "storeName", s.id AS "sessionId", s.flag_reason AS reason,
                  s.is_bot AS "isBot", s.flagged_at AS "flaggedAt", s.excluded_events AS "excludedEvents",
                  s.ip_hash AS "ipHash", s.country, s.device, s.browser, s.os
             FROM analytics_sessions s JOIN workspaces w ON w.id = s.workspace_id
            WHERE s.flagged_at >= ((now() AT TIME ZONE 'UTC')::date - CAST(:days AS integer))::timestamp AT TIME ZONE 'UTC'
                  ${workspaceId ? 'AND s.workspace_id = :workspaceId' : ''}
            ORDER BY s.flagged_at DESC LIMIT 50`,
          replacements
        ),
  ]);

  return {
    scope: site ? 'site' : 'store',
    enabled: site ? Boolean(env.siteAnalytics.detailsEnabled) : guardEnabled(),
    originCheck: site ? 'allowlist' : originMode(),
    dailyCap: site ? null : storeDailyCap(),
    range,
    totals: counts(totals),
    byReason: byReason.map((r) => ({ kind: r.kind, reason: r.reason, count: toNumber(r.count) })),
    bySource: bySource.map((r) => ({ kind: r.kind, reason: r.reason, label: r.label, count: toNumber(r.count) })),
    byCountry: byCountry.map((r) => ({ country: r.country, ...counts(r) })),
    byStore: byStore.map((r) => ({ workspaceId: r.workspaceId, name: r.name, slug: r.slug, ...counts(r) })),
    daily: daily.map((r) => ({ day: r.day, ...counts(r) })),
    cappedStores: capped.map((r) => ({ ...r, stored: toNumber(r.stored), overflow: toNumber(r.overflow) })),
    flaggedSessions: flagged.map((r) => ({ ...r, excludedEvents: toNumber(r.excludedEvents) })),
  };
}

module.exports = { summary, RANGES };
