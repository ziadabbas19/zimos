'use strict';

const db = require('../../db/models');
const { InsufficientStockError, NotFoundError } = require('../../core/errors/AppError');

/**
 * Every stock mutation goes through one of the functions below: open/join a
 * transaction, lock the variant row (SELECT ... FOR UPDATE), re-check under
 * the lock, then write — so concurrent reservations for the last unit can't
 * both succeed. Each mutation also writes an InventoryMovement row in the
 * same transaction.
 */

async function lockVariant(variantId, workspaceId, transaction) {
  const variant = await db.ProductVariant.findOne({
    where: { id: variantId, workspaceId },
    lock: transaction.LOCK.UPDATE,
    transaction,
  });
  if (!variant) throw new NotFoundError('ProductVariant');
  return variant;
}

/**
 * Reserves `quantity` units of a variant (moving them from "available" to
 * "reserved" without touching stockOnHand) — used when an order is created
 * so inventory is held while confirmation/payment is pending.
 */
async function reserve({ workspaceId, variantId, quantity, referenceType, referenceId, actorUserId }, externalTransaction) {
  const run = async (transaction) => {
    const variant = await lockVariant(variantId, workspaceId, transaction);
    const available = variant.stockOnHand - variant.reservedStock;

    if (!variant.allowOverselling && available < quantity) {
      throw new InsufficientStockError(
        `Insufficient stock for variant ${variantId}: requested ${quantity}, available ${available}`
      );
    }

    await variant.update(
      { reservedStock: variant.reservedStock + quantity, version: variant.version + 1 },
      { transaction }
    );

    await db.InventoryMovement.create(
      {
        workspaceId,
        variantId,
        type: 'reserve',
        quantityDelta: 0,
        reservedDelta: quantity,
        referenceType,
        referenceId,
        actorUserId,
      },
      { transaction }
    );

    return variant;
  };

  return externalTransaction ? run(externalTransaction) : db.sequelize.transaction(run);
}

/** Releases a previously-made reservation without touching stockOnHand (e.g. order rejected/cancelled). */
async function release({ workspaceId, variantId, quantity, referenceType, referenceId, actorUserId }, externalTransaction) {
  const run = async (transaction) => {
    const variant = await lockVariant(variantId, workspaceId, transaction);
    const newReserved = Math.max(0, variant.reservedStock - quantity);

    await variant.update({ reservedStock: newReserved, version: variant.version + 1 }, { transaction });

    await db.InventoryMovement.create(
      { workspaceId, variantId, type: 'release', quantityDelta: 0, reservedDelta: -quantity, referenceType, referenceId, actorUserId },
      { transaction }
    );

    return variant;
  };
  return externalTransaction ? run(externalTransaction) : db.sequelize.transaction(run);
}

/** Converts a reservation into a permanent deduction (stockOnHand decreases, reservedStock decreases). */
async function commit({ workspaceId, variantId, quantity, referenceType, referenceId, actorUserId }, externalTransaction) {
  const run = async (transaction) => {
    const variant = await lockVariant(variantId, workspaceId, transaction);
    await variant.update(
      {
        stockOnHand: variant.stockOnHand - quantity,
        reservedStock: Math.max(0, variant.reservedStock - quantity),
        version: variant.version + 1,
      },
      { transaction }
    );

    await db.InventoryMovement.create(
      { workspaceId, variantId, type: 'commit', quantityDelta: -quantity, reservedDelta: -quantity, referenceType, referenceId, actorUserId },
      { transaction }
    );

    return variant;
  };
  return externalTransaction ? run(externalTransaction) : db.sequelize.transaction(run);
}

async function restock({ workspaceId, variantId, quantity, reason, actorUserId }, externalTransaction) {
  const run = async (transaction) => {
    const variant = await lockVariant(variantId, workspaceId, transaction);
    await variant.update({ stockOnHand: variant.stockOnHand + quantity, version: variant.version + 1 }, { transaction });

    await db.InventoryMovement.create(
      { workspaceId, variantId, type: 'restock', quantityDelta: quantity, reason, actorUserId },
      { transaction }
    );

    return variant;
  };
  return externalTransaction ? run(externalTransaction) : db.sequelize.transaction(run);
}

async function returnRestock({ workspaceId, variantId, quantity, referenceType, referenceId, actorUserId }, externalTransaction) {
  const run = async (transaction) => {
    const variant = await lockVariant(variantId, workspaceId, transaction);
    await variant.update({ stockOnHand: variant.stockOnHand + quantity, version: variant.version + 1 }, { transaction });

    await db.InventoryMovement.create(
      { workspaceId, variantId, type: 'return_restock', quantityDelta: quantity, referenceType, referenceId, actorUserId },
      { transaction }
    );
    return variant;
  };
  return externalTransaction ? run(externalTransaction) : db.sequelize.transaction(run);
}

async function adjustStock({ workspaceId, variantId, delta, reason, actorUserId }) {
  return db.sequelize.transaction(async (transaction) => {
    const variant = await lockVariant(variantId, workspaceId, transaction);
    const newStock = variant.stockOnHand + delta;
    if (newStock < 0) throw new InsufficientStockError('Adjustment would result in negative stock');

    await variant.update({ stockOnHand: newStock, version: variant.version + 1 }, { transaction });
    await db.InventoryMovement.create(
      { workspaceId, variantId, type: 'adjustment', quantityDelta: delta, reason, actorUserId },
      { transaction }
    );
    return variant;
  });
}

module.exports = { reserve, release, commit, restock, returnRestock, adjustStock, lockVariant };
