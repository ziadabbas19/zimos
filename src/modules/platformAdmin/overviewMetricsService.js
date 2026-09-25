'use strict';

const { Op, QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { listSubscriptions, aggregateMrr } = require('./platformAdminService');
const { countsAsSaleSql } = require('../orders/orderStage');

// Windows the console draws. Daily series cover today plus the 29 UTC days
// before it; the trend covers the current month plus the 11 before it. Every
// bucket is zero-filled server-side, so the client never has to decide whether
// a missing bucket means "no activity" or "no data".
const DAY_MS = 86400000;
const WINDOW_DAYS = 30;
const TREND_MONTHS = 12;

// Needs-attention thresholds.
// A return rate is meaningless on a handful of parcels — three returns out of
// four reads as 75% RTO and says nothing — so a workspace has to have finished
// at least this many shipments in the window before it can be flagged.
const RTO_MIN_SHIPMENTS = 10;
const RTO_WARNING = 0.25;
const RTO_DANGER = 0.5;
// A domain is only worth raising once the admin has plausibly finished setting
// up DNS; before that, "unverified" is just "added a minute ago".
const UNVERIFIED_DOMAIN_GRACE_DAYS = 7;
// The queue is a dashboard panel, not a work list. A platform-wide incident
// could otherwise put one row per workspace on the wire.
const ATTENTION_LIMIT = 50;

// ------------------------------------------------------------------ utilities

function utcDayKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/** The last `count` UTC day keys, oldest first, ending with today. */
function recentUtcDays(now, count) {
  const todayUtc = Date.parse(`${utcDayKey(now)}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => utcDayKey(todayUtc - (count - 1 - i) * DAY_MS));
}

/** The last `count` UTC month keys ("2026-09"), oldest first, ending with this month. */
function recentUtcMonths(now, count) {
  return Array.from({ length: count }, (_, i) => {
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (count - 1 - i), 1));
    return month.toISOString().slice(0, 7);
  });
}

/** Whole days elapsed since `date`; null when there is no date to measure from. */
function daysSince(date, now) {
  if (!date) return null;
  const then = new Date(date).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now.getTime() - then) / DAY_MS));
}

/** Rates travel as fractions; four places is past any resolution a chart has. */
function asFraction(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

function zeroFill(labels, totals) {
  return labels.map((label) => ({ label, value: totals[label] || 0 }));
}

/**
 * Applies the platform's currency rule to a money total that is not MRR.
 *
 * The rule itself — total per currency, answer with one number only when the
 * contributors agree on a currency, and refuse with null when they do not,
 * because there is no FX layer to convert through — lives in `aggregateMrr`
 * and is deliberately not restated here. A second copy would drift from it,
 * and a drifted currency check still returns a number, so the failure would
 * look exactly like a working total. This shapes the rows `aggregateMrr`
 * already reads and renames its answer for the caller.
 */
function totalInOneCurrency(amountByCurrency) {
  const rows = Object.entries(amountByCurrency).map(([currency, amount]) => ({
    mrr: amount,
    mrrCurrency: currency,
  }));
  const { mrr, mrrCurrency, mrrByCurrency } = aggregateMrr(rows);
  return { amount: mrr, currency: mrrCurrency, byCurrency: mrrByCurrency };
}

// --------------------------------------------------------------------- queries

/**
 * Orders in the window, bucketed by UTC day and by currency.
 *
 * Cancelled orders are excluded here rather than per-metric, so the three
 * numbers this feeds — `ordersPerDay`, `ordersToday` and `gmv30d` — all
 * describe one population: orders that still stand. A cancelled order
 * therefore leaves the chart it was counted in, which is the convention the
 * revenue number has to follow anyway. A prepaid order that was never paid is
 * left out for the same reason: the shopper walked away at the payment page,
 * and nothing was sold.
 *
 * COUNT is cast to int because pg hands BIGINT to the driver as a string; SUM
 * stays BIGINT and is cast with Number() on the way out, matching the /admin
 * serializers (see the cast in platformAdminService.serializePlan).
 */
function orderBuckets(since) {
  return db.sequelize.query(
    `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
            currency,
            COUNT(*)::int AS orders,
            SUM(total_amount) AS gross
       FROM orders
      WHERE created_at >= :since
        AND cancelled_at IS NULL
        AND ${countsAsSaleSql('')}
      GROUP BY day, currency`,
    { replacements: { since }, type: QueryTypes.SELECT }
  );
}

/**
 * Shipments that reached a terminal state inside the window, per workspace.
 *
 * `updated_at` is the window column, not `created_at`: the question is how
 * many parcels finished recently, not how many of the parcels created recently
 * have finished — the second measure counts a cohort that is still in flight,
 * and reads as a collapse in delivery whenever shipping volume rises. Only
 * `delivered` has a timestamp of its own, so `updated_at` is the closest stamp
 * all three terminal states share; a later edit to a finished shipment pulls
 * it back into the window, which is rare and small next to that bias.
 */
function shipmentBuckets(since) {
  return db.sequelize.query(
    `SELECT workspace_id AS "workspaceId", status, COUNT(*)::int AS n
       FROM shipments
      WHERE status IN ('delivered', 'failed', 'returned')
        AND updated_at >= :since
      GROUP BY workspace_id, status`,
    { replacements: { since }, type: QueryTypes.SELECT }
  );
}

function signupBuckets(since) {
  return db.sequelize.query(
    `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
       FROM workspaces
      WHERE created_at >= :since
      GROUP BY day`,
    { replacements: { since }, type: QueryTypes.SELECT }
  );
}

/**
 * Paid billing invoices, by the month their period starts in.
 *
 * Real history, not today's subscription state projected backwards: there is
 * no subscription-history table, so back-projection would draw a flat line at
 * the current MRR and pass it off as a trend.
 */
function invoiceBuckets(since) {
  return db.sequelize.query(
    `SELECT to_char(period_start AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
            currency,
            SUM(amount) AS total
       FROM billing_invoices
      WHERE status = 'paid'
        AND period_start >= :since
      GROUP BY month, currency`,
    { replacements: { since }, type: QueryTypes.SELECT }
  );
}

function staleDomains(now) {
  const cutoff = new Date(now.getTime() - UNVERIFIED_DOMAIN_GRACE_DAYS * DAY_MS);
  return db.Domain.findAll({
    where: { status: 'pending_verification', createdAt: { [Op.lt]: cutoff } },
    attributes: ['id', 'workspaceId', 'createdAt'],
    order: [['createdAt', 'ASC']],
    limit: ATTENTION_LIMIT,
  });
}

/** Names for the workspaces the queue mentions — one query, never one per row. */
async function workspaceNames(ids) {
  if (ids.size === 0) return new Map();
  const rows = await db.Workspace.findAll({ where: { id: [...ids] }, attributes: ['id', 'name'] });
  return new Map(rows.map((w) => [w.id, w.name]));
}

// ------------------------------------------------------------------- assembly

const SEVERITY_RANK = { danger: 0, warning: 1, info: 2 };

/**
 * Severity first, then kind, then the largest number within that kind.
 *
 * Kind is in the sort because `value` means something different in each one —
 * days overdue, a return fraction, days unverified — so ordering across kinds
 * by it would be comparing 14 days against 0.4. Within one kind it is a real
 * ranking; `id` breaks the remaining ties, so the queue does not reshuffle
 * between two identical readings.
 */
function sortAttention(items) {
  return items.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    const byValue = (b.value ?? -1) - (a.value ?? -1);
    if (byValue !== 0) return byValue;
    return a.id < b.id ? -1 : 1;
  });
}

/**
 * Workspaces returning enough of what they ship to be worth raising.
 *
 * Computed before the names are fetched, because only a flagged workspace ever
 * needs one: every workspace that shipped a parcel this month is in the
 * bucket map, and looking all of them up to name the handful that are in
 * trouble is a query that grows with the platform for no result.
 */
function highRtoWorkspaces(shipmentsByWorkspace) {
  const flagged = [];
  for (const [workspaceId, counts] of shipmentsByWorkspace) {
    const terminal = counts.delivered + counts.failed + counts.returned;
    if (terminal < RTO_MIN_SHIPMENTS) continue;
    const rate = asFraction(counts.returned, terminal);
    if (rate === null || rate < RTO_WARNING) continue;
    flagged.push({ workspaceId, rate });
  }
  return flagged;
}

/**
 * The needs-attention queue: an identity and one number per row, with no route
 * and no prose. The console owns both — a route encoded here breaks silently
 * when the client renames it, and English copy written here cannot be
 * translated by a console that has an Arabic mode. `value`'s meaning is keyed
 * to `kind`: whole days overdue, a 0..1 return fraction, whole days unverified.
 *
 * `carrier_error` is in the client's type union but has no table behind it, so
 * nothing emits it. Three kinds, not four.
 */
function buildAttention(subscriptions, highRto, domains, names, now) {
  const items = [];

  for (const sub of subscriptions) {
    if (sub.status !== 'past_due') continue;
    items.push({
      // The same id the console's own fallback builds for this row, so moving
      // between derived and served data keeps its list keys stable.
      id: `past_due:${sub.workspaceId}`,
      kind: 'past_due',
      severity: 'danger',
      workspaceId: sub.workspaceId,
      workspaceName: sub.workspaceName,
      // The period end is when payment was due, so time since it is how long
      // the account has been overdue.
      value: daysSince(sub.currentPeriodEnd, now),
    });
  }

  for (const { workspaceId, rate } of highRto) {
    items.push({
      id: `high_rto:${workspaceId}`,
      kind: 'high_rto',
      severity: rate >= RTO_DANGER ? 'danger' : 'warning',
      workspaceId,
      workspaceName: names.get(workspaceId) ?? null,
      value: rate,
    });
  }

  for (const domain of domains) {
    items.push({
      id: `unverified_domain:${domain.id}`,
      kind: 'unverified_domain',
      severity: 'warning',
      workspaceId: domain.workspaceId,
      workspaceName: names.get(domain.workspaceId) ?? null,
      value: daysSince(domain.createdAt, now),
    });
  }

  return sortAttention(items).slice(0, ATTENTION_LIMIT);
}

/**
 * The MRR trend, or null.
 *
 * This is money, so the same currency rule applies: paid invoices spanning
 * several currencies cannot be added into one series, and a series that
 * silently did would look like a trend rather than like a bug. The window is
 * judged as a whole — one currency gets twelve zero-filled buckets, anything
 * else gets null — because a line whose unit changes halfway along is not a
 * line anyone can read. `mrrTrendCurrency` names that unit: the agreed chart
 * point carries only a label and a value, so without it the series has no
 * stated currency at all.
 *
 * Null (never twelve zeros) when no paid invoice exists in the window — the
 * console hides the chart rather than drawing a year of flat zero.
 */
function buildMrrTrend(rows, monthLabels) {
  const byCurrency = {};
  const byMonth = {};
  for (const row of rows) {
    const total = Number(row.total);
    byCurrency[row.currency] = (byCurrency[row.currency] || 0) + total;
    byMonth[row.currency] = byMonth[row.currency] || {};
    byMonth[row.currency][row.month] = (byMonth[row.currency][row.month] || 0) + total;
  }

  const { currency } = totalInOneCurrency(byCurrency);
  if (!currency) return { mrrTrend: null, mrrTrendCurrency: null };
  return { mrrTrend: zeroFill(monthLabels, byMonth[currency]), mrrTrendCurrency: currency };
}

// ------------------------------------------------------------------- endpoint

/**
 * `GET /admin/metrics/overview` -> `{ overview: {...} }`.
 *
 * Money is JS numbers in MINOR units and is never converted: where the rows
 * behind an amount span currencies, the amount and its currency both come back
 * null. Chart labels are raw ISO bucket keys ("2026-09-16" daily, "2026-09"
 * monthly) so the console can format them in either of its languages, and
 * every bucket is a UTC calendar day or month.
 *
 * `workspaces` and `recentSignups` are deliberately absent: the console
 * derives both from /admin/workspaces, which already returns createdAt and
 * subscriptionStatus, and serving them here would give one table two sources.
 */
async function getOverview() {
  const now = new Date();
  const dayLabels = recentUtcDays(now, WINDOW_DAYS);
  const monthLabels = recentUtcMonths(now, TREND_MONTHS);
  const windowStart = new Date(`${dayLabels[0]}T00:00:00Z`);
  const trendStart = new Date(`${monthLabels[0]}-01T00:00:00Z`);

  const [subs, orders, shipments, signups, invoices, domains] = await Promise.all([
    // The subscriptions endpoint's whole envelope, reused as it stands: the
    // KPI and the /admin/subscriptions page are then the same number by
    // construction, rather than two sums that agree until one of them changes.
    listSubscriptions(),
    orderBuckets(windowStart),
    shipmentBuckets(windowStart),
    signupBuckets(windowStart),
    invoiceBuckets(trendStart),
    staleDomains(now),
  ]);

  const ordersPerDayTotals = {};
  const gmvByCurrency = {};
  for (const row of orders) {
    ordersPerDayTotals[row.day] = (ordersPerDayTotals[row.day] || 0) + row.orders;
    gmvByCurrency[row.currency] = (gmvByCurrency[row.currency] || 0) + Number(row.gross);
  }
  const gmv = totalInOneCurrency(gmvByCurrency);

  const shipmentsByWorkspace = new Map();
  const platformShipments = { delivered: 0, failed: 0, returned: 0 };
  for (const row of shipments) {
    if (!shipmentsByWorkspace.has(row.workspaceId)) {
      shipmentsByWorkspace.set(row.workspaceId, { delivered: 0, failed: 0, returned: 0 });
    }
    shipmentsByWorkspace.get(row.workspaceId)[row.status] += row.n;
    platformShipments[row.status] += row.n;
  }
  const terminalShipments =
    platformShipments.delivered + platformShipments.failed + platformShipments.returned;

  const signupTotals = {};
  for (const row of signups) signupTotals[row.day] = row.n;

  const highRto = highRtoWorkspaces(shipmentsByWorkspace);
  const names = await workspaceNames(
    new Set([...highRto.map((r) => r.workspaceId), ...domains.map((d) => d.workspaceId)])
  );
  const countByStatus = (status) => subs.subscriptions.filter((s) => s.status === status).length;

  return {
    generatedAt: now.toISOString(),
    kpis: {
      // Counted by subscription status — the same statuses the console's own
      // fallback counts off /admin/workspaces, so the figure does not jump
      // when this endpoint takes over from it.
      activeWorkspaces: countByStatus('active'),
      trialing: countByStatus('trialing'),
      pastDue: countByStatus('past_due'),
      mrr: subs.mrr,
      mrrCurrency: subs.mrrCurrency,
      // Past the agreed contract, and the only real answer in the mixed case:
      // a client handed null for `mrr` can still show the book it came from.
      mrrByCurrency: subs.mrrByCurrency,
      gmv30d: gmv.amount,
      gmv30dCurrency: gmv.currency,
      gmv30dByCurrency: gmv.byCurrency,
      // The UTC calendar day, which is the day the last bucket of
      // `ordersPerDay` covers — not the viewer's local today.
      ordersToday: ordersPerDayTotals[dayLabels[dayLabels.length - 1]] || 0,
      // A fraction, and null rather than 0 when nothing finished: "nothing was
      // delivered" and "nothing was shipped" are different statements, and a
      // zero would read as the first while meaning the second.
      deliveryRate: asFraction(platformShipments.delivered, terminalShipments),
    },
    signupsPerDay: zeroFill(dayLabels, signupTotals),
    ...buildMrrTrend(invoices, monthLabels),
    ordersPerDay: zeroFill(dayLabels, ordersPerDayTotals),
    attention: buildAttention(subs.subscriptions, highRto, domains, names, now),
  };
}

module.exports = { getOverview };
