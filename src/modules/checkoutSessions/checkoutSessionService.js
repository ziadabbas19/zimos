'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { add } = require('../../core/utils/money');
const { normalizePhone } = require('../../core/utils/phone');
const { isUuid } = require('../../core/utils/workspaceSlug');
const logger = require('../../core/utils/logger');
const { recordAudit } = require('../audit/auditService');
const { priceLines } = require('../orders/orderService');
const { STATUS_SQL } = require('./checkoutSessionStatus');

// How far back an order reaches to convert sessions by phone alone — the
// shopper who started on their phone and finished on a laptop. Older sessions
// are a different shopping trip and stay as they are.
const PHONE_MATCH_DAYS = 7;

/**
 * The storefront autosave: one open session per (workspace, visitor), created
 * on the first save and overwritten by every later one. The first save may
 * carry only a name (phone_normalized null until a number is typed); a
 * number, when sent, must be one.
 *
 * Every line is priced here from the catalogue with the order path's own
 * priceLine, so the merchant sees what the order would have cost, not what the
 * client claimed. priceLine only reads — inventory is reserved by createOrder,
 * not by pricing — and no customer row is made: a shopper who never ordered
 * is not a customer yet.
 *
 * The write is one INSERT ... ON CONFLICT against the partial unique index on
 * (workspace_id, visitor_id) WHERE status = 'in_progress' (migration 091). Two
 * autosaves racing for a visitor with no open session cannot both insert: the
 * second waits on the first's index entry and turns into the update. A
 * converted row is outside that index, so it is never the conflict target —
 * the next save from that visitor inserts a new session instead, and a save
 * racing a conversion re-checks after the conversion commits and inserts too.
 */
async function capture(workspaceId, { contact, items, source = 'store', visitorId }, visitor = {}) {
  const phoneNormalized = contact.phone ? normalizePhone(contact.phone) : null;
  if (contact.phone && !phoneNormalized) throw new AppError('INVALID_PHONE', 'A valid phone number is required', 422);
  if (!phoneNormalized && !(contact.fullName && String(contact.fullName).trim())) {
    throw new AppError('CONTACT_REQUIRED', 'A name or a phone number is required', 422);
  }

  // A product A/B test's price for this visitor (catalog/productTests.js), as the order will charge it.
  const pinned = await require('../catalog/productTests').pinPrices(workspaceId, items, visitorId);
  const priced = await priceLines(workspaceId, pinned);

  const snapshot = priced.map((line) => ({
    productId: line.productId,
    variantId: line.variantId,
    productName: line.productName,
    options: line.variantOptions,
    offerName: line.offerName,
    quantity: line.quantity,
    lineTotalAmount: Number(line.lineTotalAmount),
  }));

  const contactFields = {
    fullName: contact.fullName || null,
    phone: contact.phone || null,
    email: contact.email || null,
  };

  const [row] = await db.sequelize.query(
    `INSERT INTO checkout_sessions
       (id, workspace_id, visitor_id, contact_fields, phone_normalized, items, subtotal_amount, currency, source,
        ip_address, ip_country, last_activity_at, created_at, updated_at)
     VALUES
       ($id, $workspaceId, $visitorId, $contactFields::jsonb, $phoneNormalized, $items::jsonb, $subtotal, $currency,
        $source, $ipAddress, $ipCountry, now(), now(), now())
     ON CONFLICT (workspace_id, visitor_id) WHERE status = 'in_progress' AND visitor_id IS NOT NULL
     DO UPDATE SET
       -- A save without a number (a name typed while the number is being edited)
       -- keeps the number the session already has.
       contact_fields = CASE WHEN EXCLUDED.phone_normalized IS NULL
                             THEN EXCLUDED.contact_fields || jsonb_build_object('phone', checkout_sessions.contact_fields->'phone')
                             ELSE EXCLUDED.contact_fields END,
       phone_normalized = COALESCE(EXCLUDED.phone_normalized, checkout_sessions.phone_normalized),
       items = EXCLUDED.items,
       subtotal_amount = EXCLUDED.subtotal_amount,
       currency = EXCLUDED.currency,
       source = EXCLUDED.source,
       -- The latest address the shopper saved from (SPEC §6.1: IP and country on the lost order).
       ip_address = COALESCE(EXCLUDED.ip_address, checkout_sessions.ip_address),
       ip_country = CASE WHEN EXCLUDED.ip_address IS NULL THEN checkout_sessions.ip_country ELSE EXCLUDED.ip_country END,
       last_activity_at = now(),
       updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    {
      bind: {
        id: crypto.randomUUID(),
        workspaceId,
        visitorId,
        contactFields: JSON.stringify(contactFields),
        phoneNormalized,
        items: JSON.stringify(snapshot),
        subtotal: add(...priced.map((line) => line.lineTotalAmount)),
        // Like createOrder: the order's currency is its first line's.
        currency: priced[0].currency,
        source,
        ipAddress: visitor.ip || null,
        ipCountry: visitor.ipCountry || null,
      },
      type: QueryTypes.SELECT,
    }
  );

  await announce(workspaceId, row, { contactFields, snapshot, priced, source });
  return { id: row.id };
}

// checkout.updated for a name or email edit at most this often per session: an autosave fires every pause in typing.
const UPDATED_EVERY_SECONDS = 60;

/**
 * The checkout.created / checkout.updated webhook topics (webhooks/webhookTopics.js):
 * the first save of a session, then each new number or change of lines, and
 * other edits (the name, the email) at most once a minute. The payload is
 * what the webhook sends: the contact, the lines and the total.
 */
async function announce(workspaceId, row, { contactFields, snapshot, priced, source }) {
  try {
    const outbox = require('../../core/outbox/outbox');
    const aggregate = { aggregateType: 'checkout', aggregateId: row.id };
    if (!row.inserted) {
      // Within a minute of the last announcement, only a new number or other lines are worth another.
      const [last] = await db.sequelize.query(
        `SELECT payload, occurred_at > now() - make_interval(secs => $secs) AS recent FROM domain_events
          WHERE aggregate_type = 'checkout' AND aggregate_id = $id AND type IN ('checkout.created', 'checkout.updated')
          ORDER BY occurred_at DESC
          LIMIT 1`,
        { bind: { id: row.id, secs: UPDATED_EVERY_SECONDS }, type: QueryTypes.SELECT }
      );
      const before = last && last.payload ? last.payload : {};
      const samePhone = ((before.contact && before.contact.phone) || null) === (contactFields.phone || null);
      // Compared field by field: jsonb gives the stored lines back with their keys reordered.
      const lineKey = (lines) => (lines || []).map((l) => `${l.variantId}:${l.quantity}:${l.lineTotalAmount}`).join('|');
      const sameLines = lineKey(before.items) === lineKey(snapshot);
      if (last && last.recent && samePhone && sameLines) return;
    }
    await outbox.record(
      null,
      row.inserted ? 'checkout.created' : 'checkout.updated',
      {
        workspaceId,
        checkoutSessionId: row.id,
        contact: contactFields,
        items: snapshot,
        subtotalAmount: String(add(...priced.map((line) => line.lineTotalAmount))),
        currency: priced[0].currency,
        source,
        productIds: [...new Set(snapshot.map((line) => line.productId).filter(Boolean))],
      },
      aggregate
    );
  } catch (err) {
    // The autosave must never fail on its announcement.
    logger.warn('Could not record a checkout event', { workspaceId, checkoutSessionId: row.id, message: err.message });
  }
}

/**
 * Marks the sessions an order came out of as converted:
 *
 *   - the one the storefront names (`checkoutSessionId`), if it is a uuid, in
 *     this workspace and not already converted — however old it is; and
 *   - every other unconverted session in the workspace with the order's phone
 *     that was active in the last PHONE_MATCH_DAYS, which is the same shopper
 *     on another device or tab.
 *
 * A session the merchant had marked 'contacted' becomes 'recovered': the
 * follow-up worked. Other recovery states are left as the merchant set them.
 *
 * Returns how many sessions were converted.
 */
async function convertForOrder(workspaceId, order, { checkoutSessionId } = {}) {
  const bind = { workspaceId, orderId: order.id };
  const arms = [];

  // Not a uuid → ignored rather than handed to Postgres, which would fail the
  // uuid cast and take the phone match down with it. An unknown id, or one
  // from another workspace, simply matches no row below.
  if (isUuid(checkoutSessionId)) {
    arms.push('id = $sessionId');
    bind.sessionId = checkoutSessionId;
  }
  const phoneNormalized = normalizePhone(order.contactSnapshot && order.contactSnapshot.phone);
  if (phoneNormalized) {
    arms.push(`(phone_normalized = $phone AND last_activity_at >= now() - interval '${PHONE_MATCH_DAYS} days')`);
    bind.phone = phoneNormalized;
  }
  if (arms.length === 0) return 0;

  const [, affected] = await db.sequelize.query(
    `UPDATE checkout_sessions
        SET status = 'converted',
            converted_order_id = $orderId,
            recovery_status = CASE WHEN recovery_status = 'contacted' THEN 'recovered' ELSE recovery_status END,
            updated_at = now()
      WHERE workspace_id = $workspaceId
        AND status <> 'converted'
        AND (${arms.join(' OR ')})`,
    { bind, type: QueryTypes.UPDATE }
  );
  return affected;
}

/**
 * convertForOrder for the storefront order paths, which call it after the
 * order has committed. Conversion is bookkeeping about the order, not part of
 * it: a failure here is logged and swallowed so the shopper still gets their
 * 201 for an order that exists. Goes through module.exports so a test can stub
 * convertForOrder and prove exactly that.
 */
async function convertAfterOrder(workspaceId, order, options = {}) {
  try {
    const converted = await module.exports.convertForOrder(workspaceId, order, options);
    // Lost orders: clears the waiting-for-code mark and announces a recovered checkout (never throws).
    // eslint-disable-next-line global-require
    if (converted) await require('./lostOrderService').afterConversion(workspaceId, order);
    return converted;
  } catch (err) {
    logger.error('Could not convert checkout sessions for an order', {
      workspaceId,
      orderId: order.id,
      message: err.message,
    });
    return 0;
  }
}

const SESSION_SELECT = `
  SELECT cs.id, ${STATUS_SQL} AS status, cs.recovery_status, cs.contact_fields, cs.phone_normalized, cs.items,
         cs.subtotal_amount, cs.currency, cs.source, cs.last_activity_at, cs.contacted_at, cs.created_at,
         o.id AS order_id, o.order_number
    FROM checkout_sessions cs
    LEFT JOIN orders o ON o.id = cs.converted_order_id AND o.workspace_id = cs.workspace_id`;

function serialize(row) {
  const contact = row.contact_fields || {};
  return {
    id: row.id,
    status: row.status,
    recoveryStatus: row.recovery_status,
    customerName: contact.fullName || null,
    // What the shopper typed, which is what the merchant will dial; the
    // normalized form only if the raw one is somehow missing.
    phone: contact.phone || row.phone_normalized,
    email: contact.email || null,
    items: row.items,
    subtotalAmount: Number(row.subtotal_amount),
    currency: row.currency,
    source: row.source,
    lastActivityAt: row.last_activity_at,
    contactedAt: row.contacted_at,
    createdAt: row.created_at,
    convertedOrder: row.order_id ? { id: row.order_id, orderNumber: row.order_number } : null,
  };
}

async function getSession(workspaceId, sessionId) {
  const rows = await db.sequelize.query(`${SESSION_SELECT} WHERE cs.workspace_id = $workspaceId AND cs.id = $sessionId`, {
    bind: { workspaceId, sessionId },
    type: QueryTypes.SELECT,
  });
  if (rows.length === 0) throw new NotFoundError('CheckoutSession');
  return serialize(rows[0]);
}

/**
 * The merchant's abandoned-checkouts list, newest activity first.
 *
 * Keyset paging on (last_activity_at, id), like the orders list: `before` is
 * the last session id of the previous page, looked up inside the workspace so
 * a foreign or unknown id is a 422 on `before`, not an anchor in someone
 * else's data. The anchor's timestamp is read in SQL rather than round-tripped
 * through JS: last_activity_at is written by now() with microsecond precision,
 * and a JS Date would truncate it to milliseconds and skip the rows in between.
 */
async function listSessions(workspaceId, { view = 'abandoned', recoveryStatus, limit = 30, before } = {}) {
  const conditions = ['cs.workspace_id = $workspaceId'];
  const bind = { workspaceId, limit: limit + 1 };

  if (view !== 'all') {
    conditions.push(`${STATUS_SQL} = $view`);
    bind.view = view;
  }
  if (recoveryStatus) {
    conditions.push('cs.recovery_status = $recoveryStatus');
    bind.recoveryStatus = recoveryStatus;
  }
  if (before) {
    const anchor = await db.CheckoutSession.findOne({ where: { id: before, workspaceId }, attributes: ['id'] });
    if (!anchor) {
      throw new ValidationError(
        [{ field: 'before', message: 'Cursor does not point at a checkout session in this workspace' }],
        'Invalid query'
      );
    }
    conditions.push(
      '(cs.last_activity_at, cs.id) < (SELECT a.last_activity_at, a.id FROM checkout_sessions a WHERE a.id = $beforeId)'
    );
    bind.beforeId = anchor.id;
  }

  const rows = await db.sequelize.query(
    `${SESSION_SELECT}
      WHERE ${conditions.join(' AND ')}
      ORDER BY cs.last_activity_at DESC, cs.id DESC
      LIMIT $limit`,
    { bind, type: QueryTypes.SELECT }
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return { sessions: page.map(serialize), nextCursor: hasMore ? page[page.length - 1].id : null };
}

/**
 * The merchant recording their follow-up. 'contacted' stamps contacted_at the
 * first time only, so the list keeps showing when the merchant first reached
 * out even if they re-mark it after a 'lost'.
 */
async function updateRecoveryStatus(workspaceId, sessionId, { recoveryStatus }, req) {
  await db.sequelize.transaction(async (transaction) => {
    const session = await db.CheckoutSession.findOne({
      where: { id: sessionId, workspaceId },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });
    if (!session) throw new NotFoundError('CheckoutSession');

    const previous = session.recoveryStatus;
    session.recoveryStatus = recoveryStatus;
    if (recoveryStatus === 'contacted' && !session.contactedAt) session.contactedAt = new Date();
    await session.save({ transaction });

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'checkout_session.recovery_update',
      entityType: 'CheckoutSession',
      entityId: session.id,
      before: { recoveryStatus: previous },
      after: { recoveryStatus },
      req,
      transaction,
    });
  });

  return getSession(workspaceId, sessionId);
}

module.exports = {
  PHONE_MATCH_DAYS,
  capture,
  convertForOrder,
  convertAfterOrder,
  getSession,
  listSessions,
  updateRecoveryStatus,
};
