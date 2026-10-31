'use strict';

const db = require('../../db/models');
const { InsufficientStockError, NotFoundError } = require('../../core/errors/AppError');
// Records product.low_stock when a change takes a variant to its threshold.
require('./lowStockEvent');

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

// In stock as the storefront shows it (storefront/publicProduct.js): a boolean, never the count.
const inStock = (variant) => Boolean(variant.allowOverselling) || variant.stockOnHand - variant.reservedStock > 0;

/**
 * Reserves `quantity` units of a variant (moving them from "available" to
 * "reserved" without touching stockOnHand) — used when an order is created
 * so inventory is held while confirmation/payment is pending.
 */
async function reserve({ workspaceId, variantId, quantity, referenceType, referenceId, actorUserId }, externalTransaction) {
  const run = async (transaction) => {
    const variant = await lockVariant(variantId, workspaceId, transaction);
    const available = variant.stockOnHand - variant.reservedStock;

    // A product taking pre-orders sells beyond its stock, up to its limit (modules/preorders).
    if (!variant.allowOverselling && available < quantity && !(await require('../preorders').allowsPreorder(variant, quantity, transaction))) {
      throw new InsufficientStockError(
        `Insufficient stock for variant ${variantId}: requested ${quantity}, available ${available}`
      );
    }

    const wasInStock = inStock(variant);
    await variant.update(
      { reservedStock: variant.reservedStock + quantity, version: variant.version + 1 },
      { transaction }
    );
    if (inStock(variant) !== wasInStock) dropStoreCache(workspaceId, transaction);

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

    const wasInStock = inStock(variant);
    await variant.update({ reservedStock: newReserved, version: variant.version + 1 }, { transaction });
    if (inStock(variant) !== wasInStock) dropStoreCache(workspaceId, transaction);

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
    const wasInStock = inStock(variant);
    await variant.update(
      {
        stockOnHand: variant.stockOnHand - quantity,
        reservedStock: Math.max(0, variant.reservedStock - quantity),
        version: variant.version + 1,
      },
      { transaction }
    );
    if (inStock(variant) !== wasInStock) dropStoreCache(workspaceId, transaction);

    await db.InventoryMovement.create(
      { workspaceId, variantId, type: 'commit', quantityDelta: -quantity, reservedDelta: -quantity, referenceType, referenceId, actorUserId },
      { transaction }
    );

    return variant;
  };
  return externalTransaction ? run(externalTransaction) : db.sequelize.transaction(run);
}

// Stock the merchant adds or corrects shows in the store at once, not after
// the storefront cache's 60 s (storefront/storefrontCache.js), at Cloudflare
// too. An order's reservation, release or commit drops it only when the
// variant goes out of stock or comes back: any other order leaves it be (a
// busy store would never be cached).
function dropStoreCache(workspaceId, transaction) {
  transaction.afterCommit(() => require('../storefront/storefrontCache').invalidate(workspaceId));
}

async function restock({ workspaceId, variantId, quantity, reason, actorUserId }, externalTransaction) {
  const run = async (transaction) => {
    const variant = await lockVariant(variantId, workspaceId, transaction);
    await variant.update({ stockOnHand: variant.stockOnHand + quantity, version: variant.version + 1 }, { transaction });

    await db.InventoryMovement.create(
      { workspaceId, variantId, type: 'restock', quantityDelta: quantity, reason, actorUserId },
      { transaction }
    );
    dropStoreCache(workspaceId, transaction);

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
    dropStoreCache(workspaceId, transaction);
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
    dropStoreCache(workspaceId, transaction);
    return variant;
  });
}

module.exports = { reserve, release, commit, restock, returnRestock, adjustStock, lockVariant };
