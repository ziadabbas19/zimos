'use strict';

const { createIndexConcurrently, dropIndexConcurrently } = require('../concurrentIndex');
const { withShortLock } = require('../shortLock');

/**
 * Locked orders and the fee charged when an order is confirmed
 * (orders/orderLock.js, billing/confirmFeeService.js, ORDERS_LOCK_ENABLED;
 * nothing below changes what anyone sees while it is off).
 *
 * orders.contact_lock
 *   written when the order reaches its confirmed stage (a COD confirmation,
 *   or an online payment landing), whatever the switch says:
 *     unlocked  its customer's details stay visible for good (confirmed while
 *               the store was entitled to them, or its fee was paid, or it
 *               used a free order);
 *     due       paid online while its fee could not be paid: hidden until the
 *               fee is taken (after a top-up, see confirmFeeService);
 *     null      not confirmed yet, or confirmed before this column existed.
 *   Added without a default (no table rewrite); its CHECK is added NOT VALID
 *   and validated after, so the orders table is never locked for a scan.
 *   orders_contact_lock_due_idx (CONCURRENTLY) finds a store's due orders.
 *
 * wallet_ledger_entries type 'order_confirm_fee'
 *   the fee taken once when an order is confirmed (cash, or a free order).
 *   wallet_ledger_entries_confirm_fee_once (UNIQUE, CONCURRENTLY) on
 *   (order_id, entry_type) for that type only: a second charge for the same
 *   order is refused by the database itself. The type CHECK is read and
 *   extended (as migration 224 does for the notification types), so types
 *   added by other migrations are kept.
 *
 * webhook_order_holds
 *   the orders whose webhooks wait because they are locked
 *   (webhooks/orderChangeDetector.js): one row per order, from the first
 *   change the observer saw while it was locked until it opens, when its
 *   events go out as if it had just changed (and the row goes). checked_at
 *   paces how often a held order is looked at again.
 *
 * Locks (db/shortLock): every statement that takes a heavy lock — the
 * column, the CHECKs, the table with its foreign keys to orders and
 * workspaces — runs in its own short transaction under SET LOCAL
 * lock_timeout = 3s, tried again when the lock is not granted, so a long
 * transaction on orders at deploy time never queues the checkout behind it.
 * Both CHECKs go in NOT VALID and are validated by a step of their own (that
 * lock lets reads and writes go on); the indexes are built CONCURRENTLY.
 *
 * No data is written. Run-twice safe: each step looks first. Down drops the
 * table, the indexes and the column — the 'due' marks go with it, so a later
 * run of up reads those orders as confirmed before the column existed
 * (visible, no fee) — and the held webhooks are forgotten; entries of the new
 * type stay (the ledger is append-only) and the old type CHECK comes back NOT
 * VALID.
 */

const FEE_TYPE = 'order_confirm_fee';
const TYPE_CHECK = 'wallet_ledger_entries_type_check';
const LOCK_CHECK = 'orders_contact_lock_check';
const DUE_INDEX = 'orders_contact_lock_due_idx';
const ONCE_INDEX = 'wallet_ledger_entries_confirm_fee_once';
const HOLDS_INDEX = 'webhook_order_holds_checked_at_idx';

const list = (values) => values.map((v) => `'${v}'`).join(', ');

async function constraintDef(queryInterface, name) {
  const [rows] = await queryInterface.sequelize.query('SELECT pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint WHERE conname = :name', {
    replacements: { name },
  });
  return rows[0] || null;
}

async function ledgerTypes(queryInterface) {
  const row = await constraintDef(queryInterface, TYPE_CHECK);
  return row ? [...row.def.matchAll(/'([^']+)'/g)].map((m) => m[1]) : null;
}

// The type CHECK replaced in one short transaction, NOT VALID: no scan while the table is held.
async function setLedgerTypes(queryInterface, types) {
  await withShortLock(queryInterface, [
    `ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS ${TYPE_CHECK}`,
    `ALTER TABLE wallet_ledger_entries ADD CONSTRAINT ${TYPE_CHECK} CHECK (entry_type IN (${list(types)})) NOT VALID`,
  ]);
}

async function validate(queryInterface, table, name) {
  const row = await constraintDef(queryInterface, name);
  if (row && !row.convalidated) await withShortLock(queryInterface, `ALTER TABLE ${table} VALIDATE CONSTRAINT ${name}`);
}

module.exports = {
  up: async (queryInterface) => {
    await withShortLock(queryInterface, 'ALTER TABLE orders ADD COLUMN IF NOT EXISTS contact_lock VARCHAR(10)');
    if (!(await constraintDef(queryInterface, LOCK_CHECK))) {
      await withShortLock(
        queryInterface,
        `ALTER TABLE orders ADD CONSTRAINT ${LOCK_CHECK} CHECK (contact_lock IS NULL OR contact_lock IN ('unlocked', 'due')) NOT VALID`
      );
    }
    await validate(queryInterface, 'orders', LOCK_CHECK);
    await createIndexConcurrently(queryInterface, {
      name: DUE_INDEX,
      table: 'orders',
      definition: "(workspace_id, created_at) WHERE contact_lock = 'due'",
    });

    const types = await ledgerTypes(queryInterface);
    if (types && !types.includes(FEE_TYPE)) await setLedgerTypes(queryInterface, [...types, FEE_TYPE]);
    await validate(queryInterface, 'wallet_ledger_entries', TYPE_CHECK);
    await createIndexConcurrently(queryInterface, {
      name: ONCE_INDEX,
      table: 'wallet_ledger_entries',
      definition: `(order_id, entry_type) WHERE entry_type = '${FEE_TYPE}'`,
      unique: true,
    });

    // A new, empty table: its foreign keys hold orders and workspaces (SHARE ROW EXCLUSIVE) only
    // for this short transaction, and have nothing to check.
    await withShortLock(
      queryInterface,
      `CREATE TABLE IF NOT EXISTS webhook_order_holds (
         order_id UUID NOT NULL PRIMARY KEY REFERENCES orders (id) ON DELETE CASCADE ON UPDATE CASCADE,
         workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE ON UPDATE CASCADE,
         held_at TIMESTAMP WITH TIME ZONE NOT NULL,
         checked_at TIMESTAMP WITH TIME ZONE NOT NULL,
         created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
         updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
       )`
    );
    await createIndexConcurrently(queryInterface, { name: HOLDS_INDEX, table: 'webhook_order_holds', definition: '(checked_at)' });
  },

  down: async (queryInterface) => {
    // Its foreign keys go with it: orders and workspaces held for this short transaction only.
    await withShortLock(queryInterface, 'DROP TABLE IF EXISTS webhook_order_holds');
    await dropIndexConcurrently(queryInterface, ONCE_INDEX);
    const types = await ledgerTypes(queryInterface);
    if (types && types.includes(FEE_TYPE)) {
      await setLedgerTypes(
        queryInterface,
        types.filter((t) => t !== FEE_TYPE)
      );
    }

    await dropIndexConcurrently(queryInterface, DUE_INDEX);
    await withShortLock(queryInterface, [
      `ALTER TABLE orders DROP CONSTRAINT IF EXISTS ${LOCK_CHECK}`,
      'ALTER TABLE orders DROP COLUMN IF EXISTS contact_lock',
    ]);
  },
};
