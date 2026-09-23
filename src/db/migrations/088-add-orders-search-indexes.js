'use strict';

/**
 * Indexes for the orders search box (`?q=` on the list and on
 * /orders/pipeline).
 *
 * The search is deliberately one box over four fields — order number, contact
 * name, contact email, contact phone — because that is what a merchant has in
 * front of them when a customer calls. In SQL that is an OR of four
 * predicates, and an OR is all-or-nothing for the planner: it can only answer
 * from indexes if *every* arm has one. Index three arms and the fourth forces
 * a scan, at which point the other three indexes are dead weight that nobody
 * ever reads and every INSERT still pays for. So these four are added
 * together or not at all.
 *
 * Three of the arms are `LIKE '%term%'`, which no btree can serve — hence
 * pg_trgm. It was not taken on faith. Measured on this schema with 100k
 * orders across 4 workspaces (25k in the workspace being searched), 50k
 * shipments, searching a term that matches one order — the realistic case,
 * one customer being looked up. Best of three EXPLAIN ANALYZE runs each:
 *
 *                                 list    counts   Arabic    2-char
 *   no search indexes            188ms     191ms    203ms     204ms
 *   phone expression index only  208ms     201ms    190ms     194ms
 *   all four (this migration)   0.109ms   0.109ms  0.130ms    192ms
 *
 * The middle row is the point about ORs made concrete: indexing the phone arm
 * alone changed nothing — within noise of the baseline — because the planner
 * still had to scan for the three LIKE arms, and a scan re-checks every arm
 * anyway. With all four present the plan switches to a BitmapOr across them
 * and the scan disappears. And the cost being removed grows with a merchant's
 * order history — "Rows Removed by Filter: 24999" is one workspace's whole
 * table, walked on every search, twice per keystroke-driven search once the
 * tab counts are refreshed alongside the list.
 *
 * The baseline is roughly twice what it was when these arms compared through
 * plain `lower()` (85-96ms measured before zimos_normalize_search was
 * introduced): folding Arabic costs two translate() calls per row per arm.
 * That is a fair price for a search that actually works in Arabic, and it is
 * precisely why it is paid once at write time in an index rather than on
 * every row of every search.
 *
 * Cost: ~12MB of GIN across the three text indexes and ~5MB of btree for the
 * phone one, per 100k orders — against a 31MB heap. Orders are insert-heavy
 * but update-light, and `contact_snapshot` is written once and never edited
 * afterwards (orderService.updateOrderLimited only touches the address and
 * the notes), so the GIN pending-list churn stays bounded.
 *
 * Two things these indexes deliberately do not do:
 *
 *  - They do not lead with workspace_id. A GIN index cannot take a scalar
 *    leading column without btree_gin, and it does not need to: a trigram
 *    match is already selective enough that filtering the handful of hits by
 *    workspace on the heap costs nothing. The workspace filter is still in
 *    the query and still enforced — the bitmap is rechecked against it.
 *  - They do not help a two-character search. `%ab%` has no trigram in it, so
 *    Postgres falls back to a scan (measured: 192ms, the same as baseline).
 *    The list is still correct and still bounded by the LIMIT; it is just the
 *    one search shape that stays linear. Raising the minimum `q` length to 3
 *    would close that, and is the cheap fix if it ever shows up as slow.
 *
 * The expressions below are byte-for-byte what orderService builds. An index
 * expression that merely means the same thing as the query's is never used,
 * so these two must be kept in step.
 */
const TRGM_INDEXES = [
  {
    name: 'orders_order_number_trgm_idx',
    definition: 'USING gin (zimos_normalize_search(order_number) gin_trgm_ops)',
  },
  {
    name: 'orders_contact_name_trgm_idx',
    definition: "USING gin (zimos_normalize_search(contact_snapshot->>'fullName') gin_trgm_ops)",
  },
  {
    name: 'orders_contact_email_trgm_idx',
    definition: "USING gin (zimos_normalize_search(contact_snapshot->>'email') gin_trgm_ops)",
  },
  {
    // The phone arm compares the last ten digits of both sides, so the index
    // stores exactly that. workspace_id leads because this one is a btree and
    // can take it, which keeps it useful for a phone-only lookup too.
    name: 'orders_contact_phone_tail_idx',
    definition:
      "(workspace_id, right(regexp_replace(coalesce(contact_snapshot->>'phone', ''), '[^0-9]', '', 'g'), 10))",
  },
];

/**
 * The text-folding rule the search compares through, shared by the indexes
 * above and by the query in orderService.
 *
 * `lower()` alone is an ASCII answer to a bilingual problem. Arabic has no
 * case, so lowercasing does nothing for it, while the letters merchants and
 * customers actually vary on are these:
 *
 *   أ إ آ ٱ  ->  ا      the four alef forms, typed interchangeably
 *   ة        ->  ه      taa marbuta, routinely written as haa
 *   ى        ->  ي      alef maqsura vs yaa, the same key to most typists
 *   tashkeel        dropped   the short-vowel marks (U+064B..U+0652)
 *   tatweel         dropped   U+0640, the decorative letter-stretcher
 *
 * Without this, "احمد" does not find "أحمد" and "فاطمه" does not find
 * "فاطمة" — and the customer on the phone is the one who spells it the other
 * way. The rule folds the common variants onto one form so both sides of the
 * comparison land in the same place. It is not a transliteration and not a
 * full Unicode normalization; it is the short list of confusions that come up
 * daily in Egyptian order data.
 *
 * In the function body the characters are written as U&'\XXXX' escapes rather
 * than literally (the table above is a comment and can afford to be
 * readable). A mangled byte inside the definition would not fail loudly — it
 * would quietly stop folding one letter — so the part that has to be exact is
 * written in a form no editor or pipeline can corrupt.
 *
 * IMMUTABLE is required (an index expression cannot call a volatile
 * function) and is true: same input, same output, no table or setting read.
 * The consequence to respect is that the three GIN indexes store the output
 * of *this* definition. CREATE OR REPLACE with different behaviour would not
 * rebuild them, and the indexes would silently start disagreeing with the
 * query. Changing the rule means a new migration that drops the indexes,
 * replaces the function, and rebuilds them.
 */
const NORMALIZE_FUNCTION = `
  CREATE OR REPLACE FUNCTION zimos_normalize_search(value text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  AS $fn$
    SELECT lower(
      translate(
        -- tashkeel (U+064B..U+0652) and tatweel (U+0640) removed: translate
        -- deletes any character in its second argument that has no
        -- counterpart in its third.
        translate(coalesce(value, ''),
                  U&'\\064B\\064C\\064D\\064E\\064F\\0650\\0651\\0652\\0640', ''),
        U&'\\0623\\0625\\0622\\0671\\0629\\0649',
        U&'\\0627\\0627\\0627\\0627\\0647\\064A'))
  $fn$;`;

module.exports = {
  up: async (queryInterface) => {
    // Bundled with Postgres itself (contrib), and this database already
    // creates citext the same way in 001-enable-extensions, so the deploy
    // role demonstrably has the rights for it.
    await queryInterface.sequelize.query('CREATE EXTENSION IF NOT EXISTS pg_trgm;');

    // Before the indexes: three of them are built on its output.
    await queryInterface.sequelize.query(NORMALIZE_FUNCTION);

    for (const index of TRGM_INDEXES) {
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS ${index.name} ON orders ${index.definition};`
      );
    }
  },

  down: async (queryInterface) => {
    for (const index of TRGM_INDEXES) {
      await queryInterface.sequelize.query(`DROP INDEX IF EXISTS ${index.name};`);
    }
    // After the indexes, which depend on it — Postgres would refuse the drop
    // in the other order anyway.
    await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS zimos_normalize_search(text);');
    // pg_trgm itself is left in place: other things may have come to depend
    // on it, and dropping an extension out from under them is worse than
    // leaving an unused one behind.
  },
};
