'use strict';

/**
 * Fixed-window counters in this process's memory, for the events guard: one
 * number per key, reset when its window is over. `wouldExceed` and `add` are
 * separate so a caller can check several keys and count only when all pass —
 * a refused request then uses up nobody's allowance.
 *
 * Memory is bounded: past `maxKeys` entries, every key whose window is over is
 * dropped; if that is still too many (a flood of distinct keys inside one
 * window), the oldest are dropped. A dropped key starts again from zero.
 */
function createWindowCounter({ windowMs, maxKeys = 100000, now = () => Date.now() }) {
  const entries = new Map();

  function current(key, at) {
    const entry = entries.get(key);
    if (!entry || at - entry.start >= windowMs) return null;
    return entry;
  }

  function prune(at) {
    if (entries.size <= maxKeys) return;
    for (const [key, entry] of entries) {
      if (at - entry.start >= windowMs) entries.delete(key);
    }
    if (entries.size <= maxKeys) return;
    const excess = entries.size - Math.floor(maxKeys * 0.9);
    let dropped = 0;
    for (const key of entries.keys()) {
      if (dropped >= excess) break;
      entries.delete(key);
      dropped += 1;
    }
  }

  return {
    /** The count in the key's current window (0 when there is none). */
    get(key) {
      const entry = current(key, now());
      return entry ? entry.count : 0;
    },
    /** True when adding `n` would take the key past `max`. */
    wouldExceed(key, n, max) {
      const entry = current(key, now());
      return (entry ? entry.count : 0) + n > max;
    },
    /** Adds `n` and returns the new count. */
    add(key, n = 1) {
      const at = now();
      let entry = current(key, at);
      if (!entry) {
        entry = { start: at, count: 0 };
        entries.delete(key);
        entries.set(key, entry);
        prune(at);
      }
      entry.count += n;
      return entry.count;
    },
    /** Seconds until the key's window ends (at least 1). */
    retryAfter(key) {
      const at = now();
      const entry = current(key, at);
      return entry ? Math.max(1, Math.ceil((entry.start + windowMs - at) / 1000)) : 1;
    },
    size: () => entries.size,
    clear: () => entries.clear(),
  };
}

module.exports = { createWindowCounter };
