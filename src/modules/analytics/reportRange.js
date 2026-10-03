'use strict';

const { ValidationError } = require('../../core/errors/AppError');

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * The longest window a report answers for. A longer one is refused rather
 * than quietly cut: a clamped window would compare against a "previous
 * period" the merchant never asked about.
 */
const MAX_RANGE_DAYS = 366;

/** A time zone Intl knows, or UTC. Workspace.timezone is free text. */
function validTimeZone(tz) {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/**
 * The report window from `from` / `to` (ISO dates; `to` exclusive). Without
 * `from` the window is the `defaultDays` before `to`; without `to` it ends now.
 *
 * Both ends are then rounded up to the next whole minute, so that repeated
 * requests for "the last 7 days" within one minute ask the same question (and
 * can share a cached answer), while an order placed a second ago is still
 * inside a window that ends "now". Rounding both ends the same way keeps the
 * length the caller asked for.
 *
 * Throws a 422 when `from` is not before `to`, or the window is longer than
 * MAX_RANGE_DAYS.
 */
function resolveReportRange({ from, to } = {}, { defaultDays = 30, now = new Date() } = {}) {
  const ceil = (date) => new Date(Math.ceil(date.getTime() / MINUTE_MS) * MINUTE_MS);
  const end = to ? new Date(to) : now;
  const start = from ? new Date(from) : new Date(end.getTime() - defaultDays * DAY_MS);
  if (!(start.getTime() < end.getTime())) {
    throw new ValidationError([{ field: 'from', message: '"from" must be before "to"' }], 'Invalid query');
  }
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    throw new ValidationError(
      [{ field: 'to', message: `The range can be at most ${MAX_RANGE_DAYS} days` }],
      'Invalid query'
    );
  }
  const roundedStart = ceil(start);
  const roundedEnd = ceil(end);
  // A window shorter than a minute inside one minute would round to nothing.
  if (roundedStart.getTime() === roundedEnd.getTime()) return { start: new Date(roundedEnd.getTime() - MINUTE_MS), end: roundedEnd };
  return { start: roundedStart, end: roundedEnd };
}

/** The same-length window immediately before `range`. */
function previousRange({ start, end }) {
  const span = end.getTime() - start.getTime();
  return { start: new Date(start.getTime() - span), end: new Date(start.getTime()) };
}

/** YYYY-MM-DD of `date` on the clock of `timeZone` (already validated). */
function localDay(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Every local day the window touches, in order: the day of `start` through
 * the day of the window's last instant. Steps over calendar dates rather than
 * adding 24 hours, so a daylight-saving change can neither skip nor repeat a
 * day.
 */
function daysOf({ start, end }, timeZone) {
  const first = localDay(start, timeZone);
  const last = localDay(new Date(end.getTime() - 1), timeZone);
  const days = [];
  const [y, m, d] = first.split('-').map(Number);
  for (let t = Date.UTC(y, m - 1, d); ; t += DAY_MS) {
    const key = new Date(t).toISOString().slice(0, 10);
    if (key > last) break;
    days.push(key);
  }
  return days;
}

module.exports = { MAX_RANGE_DAYS, DAY_MS, validTimeZone, resolveReportRange, previousRange, localDay, daysOf };
