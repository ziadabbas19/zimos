'use strict';

const db = require('../../../db/models');
const env = require('../../../config/env');
const logger = require('../../../core/utils/logger');
const { LIMITS, storeDailyCap } = require('./guardConfig');

/**
 * The events guard's counts, kept in this process's memory and written to the
 * database every LIMITS.FLUSH_MS — never one write per request, so a flood of
 * refused requests costs no more database work than a quiet minute.
 *
 *  - What was kept out (traffic_filter_days): per UTC day, store, kind
 *    (bot | rejected | suspicious | capped), reason, label and country. One
 *    flush writes at most MAX_FILTER_KEYS_PER_FLUSH keys; the smallest of the
 *    rest are summed under the label "other".
 *  - Raw events stored per store and UTC day (traffic_store_days), for the
 *    daily cap. A process sees the total as of its last flush plus what it
 *    stored since, so with several processes a store can pass its cap by what
 *    the others stored within one flush interval.
 *
 * When a store reaches its cap the console is told once per store and day
 * (platform notification "traffic_cap", deduplicated by the database).
 */

const NO_STORE = '';
const filtered = new Map();
const storeDays = new Map();
// Cap notifications still being written; a flush waits for them.
const notices = new Set();
let timer = null;
let flushing = null;

const utcDay = (at = new Date()) => at.toISOString().slice(0, 10);
const clip = (value, max) => String(value || '').slice(0, max);

/** Counts `count` requests or events the guard kept out. Never throws. */
function recordFiltered({ workspaceId = null, kind, reason, label = '', country = '', count = 1 }) {
  if (!count || count < 0) return;
  const row = {
    day: utcDay(),
    workspaceId: workspaceId || null,
    kind,
    reason: clip(reason, 30),
    label: clip(label, 100),
    country: /^[A-Z]{2}$/.test(country || '') ? country : '',
  };
  const key = [row.day, row.workspaceId || NO_STORE, row.kind, row.reason, row.label, row.country].join('|');
  const entry = filtered.get(key);
  if (entry) entry.count += count;
  else filtered.set(key, { ...row, count });
  ensureTimer();
}

function storeDayEntry(workspaceId, day) {
  const key = `${workspaceId}|${day}`;
  let entry = storeDays.get(key);
  if (!entry) {
    entry = { workspaceId, day, base: null, loading: null, stored: 0, overflowEvents: 0, overflowPageViews: 0, capNotified: false };
    storeDays.set(key, entry);
  }
  return entry;
}

async function loadBase(entry) {
  if (entry.base !== null) return;
  if (!entry.loading) {
    entry.loading = db.TrafficStoreDay.findOne({ where: { workspaceId: entry.workspaceId, day: entry.day }, attributes: ['storedEvents'], raw: true })
      .then((row) => {
        entry.base = row ? Number(row.storedEvents) : 0;
      })
      .catch((err) => {
        // Unknown: counted from zero rather than refusing a store's events.
        logger.warn(`[traffic] store day not read: ${err.message}`);
        entry.base = 0;
      })
      .finally(() => {
        entry.loading = null;
      });
  }
  await entry.loading;
}

/**
 * How many of `n` raw events the store may still store today. 0 means it is
 * over its cap: the caller counts them with `addOverflow` instead.
 */
async function storable(workspaceId, n) {
  const entry = storeDayEntry(workspaceId, utcDay());
  await loadBase(entry);
  const left = storeDailyCap() - (entry.base + entry.stored);
  return Math.max(0, Math.min(n, left));
}

function addStored(workspaceId, n) {
  if (!n) return;
  storeDayEntry(workspaceId, utcDay()).stored += n;
  ensureTimer();
}

/** Events past the cap: counted, not stored. Tells the console the first time a store gets here today. */
function addOverflow(workspaceId, { events = 0, pageViews = 0 } = {}) {
  if (!events) return;
  const entry = storeDayEntry(workspaceId, utcDay());
  entry.overflowEvents += events;
  entry.overflowPageViews += pageViews;
  recordFiltered({ workspaceId, kind: 'capped', reason: 'daily_cap', count: events });
  if (!entry.capNotified) {
    entry.capNotified = true;
    const notice = notifyCap(workspaceId, entry.day).finally(() => notices.delete(notice));
    notices.add(notice);
  }
  ensureTimer();
}

async function notifyCap(workspaceId, day) {
  try {
    const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'name', 'slug'] });
    await require('../../platformAdmin/platformNotificationService').notify({
      type: 'traffic_cap',
      title: 'Store over its daily analytics limit',
      body: `${workspace ? workspace.name : workspaceId} stored ${storeDailyCap()} events on ${day} (UTC); the rest of the day is counted but not stored.`,
      link: `/store-traffic?tab=protection&workspaceId=${workspaceId}`,
      workspaceId,
      data: { day, cap: storeDailyCap() },
      dedupeKey: `traffic_cap:${workspaceId}:${day}`,
    });
  } catch (err) {
    logger.warn(`[traffic] cap notification not written: ${err.message}`);
  }
}

/** Keeps the largest keys and sums the rest into one "other" row per day, kind and reason. */
function boundedRows(rows) {
  if (rows.length <= LIMITS.MAX_FILTER_KEYS_PER_FLUSH) return rows;
  const sorted = rows.slice().sort((a, b) => b.count - a.count);
  const kept = sorted.slice(0, LIMITS.MAX_FILTER_KEYS_PER_FLUSH - 20);
  const merged = new Map(kept.map((r) => [[r.day, r.workspaceId || NO_STORE, r.kind, r.reason, r.label, r.country].join('|'), { ...r }]));
  for (const r of sorted.slice(kept.length)) {
    const key = [r.day, NO_STORE, r.kind, r.reason, 'other', ''].join('|');
    const entry = merged.get(key);
    if (entry) entry.count += r.count;
    else merged.set(key, { day: r.day, workspaceId: null, kind: r.kind, reason: r.reason, label: 'other', country: '', count: r.count });
  }
  return [...merged.values()];
}

async function writeFiltered(rows) {
  if (rows.length === 0) return;
  const replacements = {};
  const values = rows.map((r, i) => {
    Object.assign(replacements, {
      [`d${i}`]: r.day,
      [`w${i}`]: r.workspaceId,
      [`k${i}`]: r.kind,
      [`r${i}`]: r.reason,
      [`l${i}`]: r.label,
      [`c${i}`]: r.country,
      [`n${i}`]: r.count,
    });
    return `(CAST(:d${i} AS date), CAST(:w${i} AS uuid), :k${i}, :r${i}, :l${i}, :c${i}, :n${i}, NOW())`;
  });
  await db.sequelize.query(
    `INSERT INTO traffic_filter_days (day, workspace_id, kind, reason, label, country, count, updated_at)
     VALUES ${values.join(', ')}
     ON CONFLICT (day, kind, reason, label, country, (coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)))
     DO UPDATE SET count = traffic_filter_days.count + EXCLUDED.count, updated_at = NOW()`,
    { replacements }
  );
}

async function writeStoreDays(entries) {
  const changed = entries.filter((e) => e.stored || e.overflowEvents);
  if (changed.length === 0) return;
  const cap = storeDailyCap();
  const replacements = { cap };
  const values = changed.map((e, i) => {
    Object.assign(replacements, {
      [`w${i}`]: e.workspaceId,
      [`d${i}`]: e.day,
      [`s${i}`]: e.stored,
      [`oe${i}`]: e.overflowEvents,
      [`op${i}`]: e.overflowPageViews,
    });
    return `(CAST(:w${i} AS uuid), CAST(:d${i} AS date), :s${i}, :oe${i}, :op${i}, CASE WHEN :oe${i} > 0 THEN NOW() END, NOW())`;
  });
  const rows = await db.sequelize.query(
    `INSERT INTO traffic_store_days (workspace_id, day, stored_events, overflow_events, overflow_page_views, cap_reached_at, updated_at)
     VALUES ${values.join(', ')}
     ON CONFLICT (workspace_id, day) DO UPDATE SET
       stored_events = traffic_store_days.stored_events + EXCLUDED.stored_events,
       overflow_events = traffic_store_days.overflow_events + EXCLUDED.overflow_events,
       overflow_page_views = traffic_store_days.overflow_page_views + EXCLUDED.overflow_page_views,
       cap_reached_at = coalesce(traffic_store_days.cap_reached_at, EXCLUDED.cap_reached_at,
                                 CASE WHEN traffic_store_days.stored_events + EXCLUDED.stored_events >= :cap THEN NOW() END),
       updated_at = NOW()
     RETURNING workspace_id AS "workspaceId", to_char(day, 'YYYY-MM-DD') AS day, stored_events AS "storedEvents"`,
    { replacements, type: db.Sequelize.QueryTypes.SELECT }
  );
  // The database total now holds this process's flushed events and every other
  // process's; what was stored here since the snapshot is still in `stored`.
  for (const row of rows) {
    const entry = storeDays.get(`${row.workspaceId}|${row.day}`);
    if (entry) entry.base = Number(row.storedEvents);
  }
}

/**
 * Writes what was counted since the last flush. Concurrent calls share one
 * run. On a database error the counts go back into memory for the next try.
 */
function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    const rows = boundedRows([...filtered.values()]);
    filtered.clear();
    const deltas = [...storeDays.values()].map((e) => ({ ...e }));
    for (const e of storeDays.values()) {
      e.stored = 0;
      e.overflowEvents = 0;
      e.overflowPageViews = 0;
    }
    try {
      await writeFiltered(rows);
    } catch (err) {
      logger.warn(`[traffic] filter counts not written: ${err.message}`);
      for (const r of rows) recordFiltered(r);
    }
    try {
      // The base each process compares with the cap moves to the new total
      // (writeStoreDays), so what it stored is not counted twice.
      for (const e of deltas) {
        const live = storeDays.get(`${e.workspaceId}|${e.day}`);
        if (live && live.base !== null) live.base += e.stored;
      }
      await writeStoreDays(deltas);
    } catch (err) {
      logger.warn(`[traffic] store day counts not written: ${err.message}`);
      for (const e of deltas) {
        const live = storeDayEntry(e.workspaceId, e.day);
        if (live.base !== null) live.base -= e.stored;
        live.stored += e.stored;
        live.overflowEvents += e.overflowEvents;
        live.overflowPageViews += e.overflowPageViews;
      }
    }
    await Promise.all([...notices]);
    // Yesterday's entries are no use once written.
    const today = utcDay();
    for (const [key, e] of storeDays) {
      if (e.day < today && !e.stored && !e.overflowEvents) storeDays.delete(key);
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

function ensureTimer() {
  if (timer || env.isTest) return;
  timer = setInterval(() => void flush(), LIMITS.FLUSH_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/** Tests: forget everything counted in memory. */
function reset() {
  filtered.clear();
  storeDays.clear();
}

module.exports = { recordFiltered, storable, addStored, addOverflow, flush, reset, utcDay };
