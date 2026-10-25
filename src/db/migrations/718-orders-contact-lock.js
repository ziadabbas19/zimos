'use strict';

const { guarded } = require('../migrationGuards');
const { createIndexConcurrently, dropIndexConcurrently } = require('../concurrentIndex');

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
 * No data is written. Run-twice safe, without a transaction (CONCURRENTLY).
 * Down drops the table, the indexes and the column; entries of the new type
 * stay (the ledger is append-only) and the old type CHECK comes back NOT VALID.
 */

const FEE_TYPE = 'order_confirm_fee';
const TYPE_CHECK = 'wallet_ledger_entries_type_check';
const LOCK_CHECK = 'orders_contact_lock_check';
const DUE_INDEX = 'orders_contact_lock_due_idx';
const ONCE_INDEX = 'wallet_ledger_entries_confirm_fee_once';

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

async function setLedgerTypes(queryInterface, types, { notValid = false } = {}) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query(`ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS ${TYPE_CHECK}`, { transaction });
    await queryInterface.sequelize.query(
      `ALTER TABLE wallet_ledger_entries ADD CONSTRAINT ${TYPE_CHECK} CHECK (entry_type IN (${list(types)}))${notValid ? ' NOT VALID' : ''}`,
      { transaction }
    );
  });
}

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { DataTypes } = Sequelize;

    await qi.addColumn('orders', 'contact_lock', { type: DataTypes.STRING(10), allowNull: true });
    const lockCheck = await constraintDef(queryInterface, LOCK_CHECK);
    if (!lockCheck) {
      await queryInterface.sequelize.query(
        `ALTER TABLE orders ADD CONSTRAINT ${LOCK_CHECK} CHECK (contact_lock IS NULL OR contact_lock IN ('unlocked', 'due')) NOT VALID`
      );
    }
    if (!lockCheck || !lockCheck.convalidated) {
      await queryInterface.sequelize.query(`ALTER TABLE orders VALIDATE CONSTRAINT ${LOCK_CHECK}`);
    }
    await createIndexConcurrently(queryInterface, {
      name: DUE_INDEX,
      table: 'orders',
      definition: "(workspace_id, created_at) WHERE contact_lock = 'due'",
    });

    const types = await ledgerTypes(queryInterface);
    if (types && !types.includes(FEE_TYPE)) await setLedgerTypes(queryInterface, [...types, FEE_TYPE]);
    await createIndexConcurrently(queryInterface, {
      name: ONCE_INDEX,
      table: 'wallet_ledger_entries',
      definition: `(order_id, entry_type) WHERE entry_type = '${FEE_TYPE}'`,
      unique: true,
    });

    await qi.createTable('webhook_order_holds', {
      order_id: {
        type: DataTypes.UUID,
        primaryKey: true,
        allowNull: false,
        references: { model: 'orders', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      workspace_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'workspaces', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      held_at: { type: DataTypes.DATE, allowNull: false },
      checked_at: { type: DataTypes.DATE, allowNull: false },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') },
    });
    // Skipped when it exists (a second run); built concurrently if the table was there already.
    await qi.addIndex('webhook_order_holds', ['checked_at'], { name: 'webhook_order_holds_checked_at_idx' });
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    await qi.dropTable('webhook_order_holds');
    await dropIndexConcurrently(queryInterface, ONCE_INDEX);
    const types = await ledgerTypes(queryInterface);
    if (types && types.includes(FEE_TYPE)) {
      await setLedgerTypes(
        queryInterface,
        types.filter((t) => t !== FEE_TYPE),
        { notValid: true }
      );
    }

    await dropIndexConcurrently(queryInterface, DUE_INDEX);
    await queryInterface.sequelize.query(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS ${LOCK_CHECK}`);
    await qi.removeColumn('orders', 'contact_lock');
  },
};
