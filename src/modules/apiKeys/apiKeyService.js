'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { PERMISSIONS } = require('../../core/security/permissions');

/**
 * Workspace API keys for the public API (modules/publicApi).
 *
 * A key looks like `zk_7Hq2mP9xa_<40 more characters>`:
 *
 *   zk_7Hq2mP9xa   the prefix — 12 characters, stored in clear (key_prefix,
 *                  unique), shown in the dashboard so a merchant can tell
 *                  their keys apart, and used to find the row
 *   the rest       the secret — never stored. Only the SHA-256 of the whole
 *                  key is (secret_hash), and the whole key is returned to the
 *                  merchant exactly once, from createKey.
 *
 * A key acts as the teammate who created it (created_by_user_id): every
 * request runs with that person's role in the workspace, intersected with the
 * key's own scopes. So a key can never do more than its creator could, it
 * stops working the moment its creator leaves the workspace, and the audit
 * log and confirmation history name a real person — the existing services
 * that write them keep working unchanged.
 */

const PREFIX_TAG = 'zk_';
const PREFIX_LENGTH = 12;
const SECRET_LENGTH = 40;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/**
 * What each scope lets a key do, as the permissions it unlocks. A request is
 * allowed when the key's creator holds the permission AND one of the key's
 * scopes lists it (apiKeyAuth.js builds req.tenant.hasPermission from this).
 * A permission no scope lists is never reachable with a key.
 */
const SCOPES = Object.freeze({
  // Also the accepted-orders feed and this key's own receipts of it
  // (publicApi/acceptedOrdersFeed.js): a receipt changes nothing on the order.
  'orders:read': [PERMISSIONS.ORDERS_VIEW],
  // A till / kitchen system: the accepted-orders feed, its receipts, and
  // where an order stands in the till (publicApi/posStatus.js) — a note
  // beside the order, never its stage. Nothing else: the order reads ask for
  // another order scope by name (publicApiRoutes.js), and it grants no
  // orders.manage, so no write route can open to it.
  'orders:pos_status': [PERMISSIONS.ORDERS_VIEW],
  // Writing an order's status means reading it back too.
  'orders:write': [PERMISSIONS.ORDERS_VIEW, PERMISSIONS.ORDERS_MANAGE, PERMISSIONS.ORDERS_CONFIRM],
  // The finer scopes of SPEC §16.2. Role permissions do not tell "create"
  // from "delete", so the routes also check the scope by name
  // (apiKeyAuth.requireScope); orders:write stays as all three in one.
  'orders:create': [PERMISSIONS.ORDERS_VIEW, PERMISSIONS.ORDERS_MANAGE],
  'orders:update': [PERMISSIONS.ORDERS_VIEW, PERMISSIONS.ORDERS_MANAGE, PERMISSIONS.ORDERS_CONFIRM],
  'orders:delete': [PERMISSIONS.ORDERS_VIEW, PERMISSIONS.ORDERS_MANAGE],
  'products:read': [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.INVENTORY_VIEW],
  'products:create': [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_MANAGE],
  'products:update': [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_MANAGE, PERMISSIONS.INVENTORY_VIEW, PERMISSIONS.INVENTORY_MANAGE],
  'products:delete': [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_MANAGE],
  'categories:read': [PERMISSIONS.PRODUCTS_VIEW],
  'categories:create': [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_MANAGE],
  'categories:update': [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_MANAGE],
  'categories:delete': [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_MANAGE],
  // Full phone numbers only when the key's creator may see them too.
  'customers:read': [PERMISSIONS.CUSTOMERS_VIEW, PERMISSIONS.CUSTOMERS_REVEAL_SENSITIVE],
  'discounts:read': [PERMISSIONS.DISCOUNTS_MANAGE],
  'discounts:write': [PERMISSIONS.DISCOUNTS_MANAGE],
  'shipping_areas:read': [PERMISSIONS.SHIPPING_MANAGE],
  'shipping_areas:write': [PERMISSIONS.SHIPPING_MANAGE],
  'webhooks:write': [PERMISSIONS.WEBHOOKS_MANAGE],
  'analytics:read': [PERMISSIONS.ANALYTICS_VIEW],
});
const SCOPE_NAMES = Object.keys(SCOPES);

function randomString(length) {
  // Rejection sampling keeps every character equally likely: 57 does not
  // divide 256, and a plain modulo would favour the first few letters.
  const out = [];
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      if (byte < limit) out.push(ALPHABET[byte % ALPHABET.length]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

const hashKey = (rawKey) => crypto.createHash('sha256').update(rawKey, 'utf8').digest('hex');

function generateKey() {
  const prefix = `${PREFIX_TAG}${randomString(PREFIX_LENGTH - PREFIX_TAG.length)}`;
  const raw = `${prefix}_${randomString(SECRET_LENGTH)}`;
  return { prefix, raw, hash: hashKey(raw) };
}

/** Everything the dashboard shows about a key. Never the hash. */
function serializeKey(key) {
  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    scopes: key.scopes,
    rateLimitPerMinute: key.rateLimitPerMinute,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
    createdAt: key.createdAt,
    createdBy: key.creator ? { id: key.creator.id, fullName: key.creator.fullName } : { id: key.createdByUserId },
  };
}

async function withCreator(key) {
  key.creator = await db.User.findByPk(key.createdByUserId, { attributes: ['id', 'fullName'] });
  return key;
}

/**
 * Mints a key. The raw key is in the answer and nowhere else, ever — the
 * dashboard shows it once and tells the merchant to copy it.
 */
async function createKey(workspaceId, { name, scopes, rateLimitPerMinute }, req) {
  // The prefix is the lookup column and unique; a clash is one in ~10^16 but
  // costs nothing to retry.
  for (let attempt = 1; ; attempt += 1) {
    const { prefix, raw, hash } = generateKey();
    try {
      const key = await db.sequelize.transaction(async (transaction) => {
        const created = await db.ApiKey.create(
          {
            workspaceId,
            name,
            keyPrefix: prefix,
            secretHash: hash,
            scopes: [...new Set(scopes)],
            rateLimitPerMinute,
            createdByUserId: req.user.id,
          },
          { transaction }
        );
        await recordAudit({
          workspaceId,
          actorUserId: req.user.id,
          action: 'api_key.create',
          entityType: 'ApiKey',
          entityId: created.id,
          req,
          after: { name, keyPrefix: prefix, scopes: created.scopes, rateLimitPerMinute },
          transaction,
        });
        return created;
      });
      return { apiKey: serializeKey(await withCreator(key)), secret: raw };
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError' && attempt < 3) continue;
      throw err;
    }
  }
}

async function listKeys(workspaceId) {
  const keys = await db.ApiKey.findAll({ where: { workspaceId }, order: [['createdAt', 'DESC']] });
  const creators = await db.User.findAll({
    where: { id: [...new Set(keys.map((k) => k.createdByUserId))] },
    attributes: ['id', 'fullName'],
  });
  const byId = new Map(creators.map((u) => [u.id, u]));
  return {
    apiKeys: keys.map((key) => {
      key.creator = byId.get(key.createdByUserId) || null;
      return serializeKey(key);
    }),
    scopes: SCOPE_NAMES,
  };
}

/** Revoking is permanent: a revoked key is kept for the audit trail, never re-enabled. */
async function revokeKey(workspaceId, keyId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const key = await db.ApiKey.findOne({ where: { id: keyId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!key) throw new NotFoundError('ApiKey');
    if (!key.revokedAt) {
      await key.update({ revokedAt: new Date() }, { transaction });
      await recordAudit({
        workspaceId,
        actorUserId: req.user.id,
        action: 'api_key.revoke',
        entityType: 'ApiKey',
        entityId: key.id,
        req,
        before: { name: key.name, keyPrefix: key.keyPrefix },
        transaction,
      });
    }
    return serializeKey(await withCreator(key));
  });
}

/**
 * The live key a raw key string belongs to, or null. Constant-time on the
 * hash so the comparison says nothing about how close a guess came.
 */
async function findActiveKey(rawKey) {
  if (typeof rawKey !== 'string' || rawKey.length !== PREFIX_LENGTH + 1 + SECRET_LENGTH) return null;
  if (!rawKey.startsWith(PREFIX_TAG) || rawKey[PREFIX_LENGTH] !== '_') return null;

  const key = await db.ApiKey.findOne({ where: { keyPrefix: rawKey.slice(0, PREFIX_LENGTH) } });
  if (!key || key.revokedAt) return null;

  const given = Buffer.from(hashKey(rawKey), 'hex');
  const stored = Buffer.from(key.secretHash, 'hex');
  if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) return null;
  return key;
}

// last_used_at is for the merchant ("is this key still in use?"), not an
// access log: one write a minute per key is plenty, and keeps a busy
// integration from turning every read into a write.
const LAST_USED_RESOLUTION_MS = 60 * 1000;

async function touchLastUsed(key, now = new Date()) {
  if (key.lastUsedAt && now - key.lastUsedAt < LAST_USED_RESOLUTION_MS) return;
  await db.ApiKey.update({ lastUsedAt: now }, { where: { id: key.id } });
}

module.exports = {
  SCOPES,
  SCOPE_NAMES,
  createKey,
  listKeys,
  revokeKey,
  findActiveKey,
  touchLastUsed,
  // exported for tests
  generateKey,
  hashKey,
};
