'use strict';

const { readOnly } = require('../analytics/traffic/visitorInsightsService');

/**
 * The console's Live view of zimos.co: the sessions seen in the last five
 * minutes, newest first. The console asks every 15 seconds; nothing here is
 * pushed (a ping every 15 seconds per visitor would flood the outbox).
 *
 * Per session: where it is from (country, governorate), where it came from
 * (UTM, else the referring host, else direct), the device, browser and
 * operating system, all from its first view; the page it is on now (its
 * latest row with a page); and its latest CTA click. "Active" is a row in the
 * last ACTIVE_SECONDS: the beacon pings every 15 seconds while the tab shows.
 *
 * Nothing new about a person: a session is a browser tab, and the visitor
 * hash changes every UTC day, so no session is tied to another day's. The
 * hash itself is not returned. A browser with GPC or DNT sends nothing, so it
 * is never here.
 *
 * Reads go through the (session_id, created_at) index of migration 709 for
 * the per-session rows and site_visits_created_at_idx for the window.
 */

const WINDOW_SECONDS = 5 * 60;
const ACTIVE_SECONDS = 45;
const LIMIT = 100;
const SOURCE_SQL = "coalesce(nullif(f.utm_source, ''), nullif(f.referrer_host, ''), 'direct')";

async function live() {
  return readOnly(async (q) => {
    const rows = await q(
      `WITH live AS (
         SELECT v.session_id, max(v.created_at) AS last_at, count(*) AS events
           FROM site_visits v
          WHERE v.created_at > now() - make_interval(secs => :window)
          GROUP BY v.session_id
          ORDER BY last_at DESC
          LIMIT ${LIMIT}
       )
       SELECT l.session_id, l.last_at, f.started_at, ${SOURCE_SQL} AS source,
              f.utm_source, f.utm_medium, f.utm_campaign, f.referrer_host,
              f.country, f.governorate, f.device_class, f.browser, f.os, f.locale,
              cur.path AS current_path, cta.cta_kind, cta.created_at AS cta_at,
              (l.last_at > now() - make_interval(secs => :active)) AS active
         FROM live l
         LEFT JOIN LATERAL (
           SELECT v.created_at AS started_at, v.utm_source, v.utm_medium, v.utm_campaign, v.referrer_host,
                  v.country, v.governorate, v.device_class, v.browser, v.os, v.locale
             FROM site_visits v
            WHERE v.session_id = l.session_id AND v.event = 'view'
            ORDER BY v.created_at, v.id
            LIMIT 1
         ) f ON true
         LEFT JOIN LATERAL (
           SELECT v.path FROM site_visits v
            WHERE v.session_id = l.session_id AND v.path IS NOT NULL
            ORDER BY v.created_at DESC, v.id DESC
            LIMIT 1
         ) cur ON true
         LEFT JOIN LATERAL (
           SELECT v.cta_kind, v.created_at FROM site_visits v
            WHERE v.session_id = l.session_id AND v.event = 'cta_click'
            ORDER BY v.created_at DESC, v.id DESC
            LIMIT 1
         ) cta ON true
        ORDER BY l.last_at DESC, l.session_id`,
      { window: WINDOW_SECONDS, active: ACTIVE_SECONDS }
    );
    const visitors = rows.map((r) => ({
      sessionId: r.session_id,
      lastSeenAt: r.last_at,
      startedAt: r.started_at || null,
      active: Boolean(r.active),
      country: r.country || null,
      governorate: r.governorate || null,
      source: r.started_at ? r.source : null,
      utmSource: r.utm_source || null,
      utmMedium: r.utm_medium || null,
      utmCampaign: r.utm_campaign || null,
      referrerHost: r.referrer_host || null,
      device: r.device_class || null,
      browser: r.browser || null,
      os: r.os || null,
      locale: r.locale || null,
      currentPath: r.current_path || null,
      // A click recorded before the link kind was kept (cta_kind null) is shown as a sign-up click, as in the funnel.
      lastCta: r.cta_at ? { kind: r.cta_kind || 'register', at: r.cta_at } : null,
    }));
    return {
      at: new Date().toISOString(),
      windowSeconds: WINDOW_SECONDS,
      activeSeconds: ACTIVE_SECONDS,
      active: visitors.filter((v) => v.active).length,
      visitors,
    };
  });
}

module.exports = { live, WINDOW_SECONDS, ACTIVE_SECONDS, LIMIT };
