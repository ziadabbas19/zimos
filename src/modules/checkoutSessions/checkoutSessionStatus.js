'use strict';

/**
 * The one definition of a checkout session's status as the merchant sees it.
 *
 * Derived in SQL at read time, never stored. "Abandoned" is nothing that
 * happens to a session — it is only the absence of activity — so storing it
 * would need a sweeper job to flip rows on a timer, and every moment between
 * two sweeps would be a moment the list disagreed with the clock. The stored
 * `status` column only ever holds 'in_progress' or 'converted' (the enum still
 * contains 'abandoned' from migration 029; no code writes it).
 *
 *   converted    an order converted the session
 *   abandoned    not converted, and nothing autosaved for ABANDON_AFTER_MINUTES
 *   in_progress  not converted, and the shopper was active more recently
 *
 * The expression assumes checkout_sessions is aliased `cs`.
 */

const ABANDON_AFTER_MINUTES = 60;

const STATUSES = ['in_progress', 'abandoned', 'converted'];

// Anything that is not converted is judged by the clock alone, so a stray
// stored 'abandoned' (none exist; nothing writes one) could not hide from
// both lists.
const STATUS_SQL = `CASE
      WHEN cs.status = 'converted' THEN 'converted'
      WHEN cs.last_activity_at < now() - interval '${ABANDON_AFTER_MINUTES} minutes' THEN 'abandoned'
      ELSE 'in_progress'
    END`;

module.exports = { ABANDON_AFTER_MINUTES, STATUSES, STATUS_SQL };
