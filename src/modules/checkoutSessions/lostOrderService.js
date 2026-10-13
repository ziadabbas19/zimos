'use strict';

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { AppError, NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { add } = require('../../core/utils/money');
const { normalizePhone } = require('../../core/utils/phone');
const { csvCell } = require('../../core/utils/csvCell');
const { isUuid } = require('../../core/utils/workspaceSlug');
const logger = require('../../core/utils/logger');
const outbox = require('../../core/outbox/outbox');
const { recordAudit } = require('../audit/auditService');
const visitorGate = require('../risk/visitorGate');

/**
 * Lost orders (SPEC §6): every checkout that did not become an order, for
 * whatever reason, on top of the existing checkout_sessions.
 *
 * A session is lost when it carries a `lost_reason` (the checkout was refused:
 * a rule, the blocklist, a bot check, an unverified phone, bad data) or when
 * nothing was autosaved for `abandoned_after_minutes` (reason `incomplete`).
 * Like "abandoned" before it, that is derived at read time — nothing sweeps
 * rows to flip a status. The stored status stays 'in_progress' / 'converted'.
 *
 * A lost order holds no stock, fires no pixel and counts in no fee: no order
 * row exists until the merchant converts it or the shopper comes back.
 */

const LOST_REASONS = [
  'incomplete',
  'invalid_data',
  'integrity_check',
  'otp_unverified',
  'outside_country',
  'vpn',
  'blocked',
  'limit_exceeded',
  'payment_failed',
];
const REVIEW_STATUSES = ['under_review', 'completed'];
const RECOVERY_STATUSES = ['not_contacted', 'contacted', 'recovered', 'lost'];
const TABS = ['all', 'under_review', 'completed', 'recovered'];
// Reasons a recovery message may follow. A blocked customer, a bot or a
// refused country is never invited back.
const RECOVERABLE_REASONS = ['otp_unverified', 'invalid_data', 'payment_failed'];

const DEFAULT_ABANDON_MINUTES = 15;
const OTP_WAIT_MINUTES = 10;
const EXPORT_MAX_ROWS = 5000;

/** `settings.fraud_rules.abandoned_after_minutes` (5–1440), default 15. */
function abandonMinutesOf(settings) {
  const raw = settings && settings.fraud_rules && settings.fraud_rules.abandoned_after_minutes;
  return Number.isInteger(raw) && raw >= 5 && raw <= 1440 ? raw : DEFAULT_ABANDON_MINUTES;
}

async function abandonMinutes(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  return abandonMinutesOf(workspace && workspace.settings);
}

// All three assume checkout_sessions is aliased `cs` and $abandonMinutes is bound.
const INACTIVE_SQL = `cs.last_activity_at < now() - make_interval(mins => $abandonMinutes::int)`;
const LOST_SQL = `(cs.status <> 'converted' AND (cs.lost_reason IS NOT NULL OR ${INACTIVE_SQL}))`;
const STATUS_SQL = `CASE
      WHEN cs.status = 'converted' THEN 'converted'
      WHEN cs.awaiting_otp AND cs.last_activity_at >= now() - interval '${OTP_WAIT_MINUTES} minutes' THEN 'awaiting_otp'
      WHEN cs.lost_reason IS NOT NULL THEN 'lost'
      WHEN ${INACTIVE_SQL} THEN 'abandoned'
      ELSE 'in_progress'
    END`;

const SELECT = `
  SELECT cs.id, ${STATUS_SQL} AS status, cs.recovery_status, cs.review_status, cs.lost_reason, cs.contact_fields,
         cs.phone_normalized, cs.items, cs.subtotal_amount, cs.currency, cs.source, cs.last_activity_at, cs.contacted_at,
         cs.created_at, cs.recovery_token, cs.ip_address, cs.ip_country, cs.checkout_payload,
         o.id AS order_id, o.order_number
    FROM checkout_sessions cs
    LEFT JOIN orders o ON o.id = cs.converted_order_id AND o.workspace_id = cs.workspace_id`;

function serialize(row) {
  const contact = row.contact_fields || {};
  const payload = row.checkout_payload || {};
  return {
    id: row.id,
    status: row.status,
    // Why it is lost; `incomplete` for a checkout that simply went quiet. Null while in progress or converted.
    lostReason: row.status === 'converted' || row.status === 'in_progress' ? null : row.lost_reason || 'incomplete',
    reviewStatus: row.review_status,
    recoveryStatus: row.recovery_status,
    customerName: contact.fullName || null,
    phone: contact.phone || row.phone_normalized,
    email: contact.email || null,
    shippingAddress: payload.shippingAddress || null,
    paymentMethod: payload.paymentMethod || null,
    items: row.items,
    subtotalAmount: Number(row.subtotal_amount),
    currency: row.currency,
    source: row.source,
    ipAddress: row.ip_address,
    ipCountry: row.ip_country,
    // The storefront path of the recovery link; the dashboard puts the store's address in front.
    recoveryPath: row.recovery_token ? `/r/${row.recovery_token}` : null,
    lastActivityAt: row.last_activity_at,
    contactedAt: row.contacted_at,
    createdAt: row.created_at,
    convertedOrder: row.order_id ? { id: row.order_id, orderNumber: row.order_number } : null,
  };
}

const newToken = () => crypto.randomBytes(18).toString('hex');

/** Gives every listed row a recovery token: sessions autosaved before this feature have none. */
async function ensureTokens(rows) {
  for (const row of rows) {
    if (row.recovery_token || row.status === 'converted') continue;
    const token = newToken();
    await db.sequelize.query(`UPDATE checkout_sessions SET recovery_token = $token WHERE id = $id AND recovery_token IS NULL`, {
      bind: { token, id: row.id },
    });
    row.recovery_token = token;
  }
}

function buildFilters(workspaceId, minutes, { tab, view, lostReason, reviewStatus, recoveryStatus, from, to, productId, source } = {}) {
  const conditions = ['cs.workspace_id = $workspaceId'];
  const bind = { workspaceId, abandonMinutes: minutes };

  // `view` is the older parameter of this list (abandoned | converted | all).
  if (view === 'converted') conditions.push(`cs.status = 'converted'`);
  else if (view === 'all') conditions.push('TRUE');
  else if (tab === 'recovered') conditions.push(`cs.recovery_status = 'recovered'`);
  else if (tab === 'under_review') conditions.push(`${LOST_SQL} AND cs.review_status = 'under_review'`);
  else if (tab === 'completed') conditions.push(`${LOST_SQL} AND cs.review_status = 'completed'`);
  else conditions.push(`(${LOST_SQL} OR cs.recovery_status = 'recovered')`);

  if (lostReason) {
    conditions.push(`cs.status <> 'converted' AND COALESCE(cs.lost_reason, 'incomplete') = $lostReason`);
    bind.lostReason = lostReason;
  }
  if (reviewStatus) {
    conditions.push('cs.review_status = $reviewStatus');
    bind.reviewStatus = reviewStatus;
  }
  if (recoveryStatus) {
    conditions.push('cs.recovery_status = $recoveryStatus');
    bind.recoveryStatus = recoveryStatus;
  }
  if (from) {
    conditions.push('cs.last_activity_at >= $from::timestamptz');
    bind.from = new Date(from).toISOString();
  }
  if (to) {
    conditions.push('cs.last_activity_at <= $to::timestamptz');
    bind.to = new Date(to).toISOString();
  }
  if (productId) {
    conditions.push('cs.items @> $productMatch::jsonb');
    bind.productMatch = JSON.stringify([{ productId }]);
  }
  if (source) {
    conditions.push('cs.source = $source');
    bind.source = source;
  }
  return { conditions, bind };
}

/** GET /checkout-sessions — newest activity first, keyset-paged on (last_activity_at, id). */
async function list(workspaceId, { limit = 30, before, ...filters } = {}) {
  const minutes = await abandonMinutes(workspaceId);
  const { conditions, bind } = buildFilters(workspaceId, minutes, filters);
  bind.limit = limit + 1;

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
    `${SELECT}
      WHERE ${conditions.join(' AND ')}
      ORDER BY cs.last_activity_at DESC, cs.id DESC
      LIMIT $limit`,
    { bind, type: QueryTypes.SELECT }
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  await ensureTokens(page);
  return { sessions: page.map(serialize), nextCursor: hasMore ? page[page.length - 1].id : null, abandonedAfterMinutes: minutes };
}

async function getOne(workspaceId, sessionId) {
  const minutes = await abandonMinutes(workspaceId);
  const rows = await db.sequelize.query(`${SELECT} WHERE cs.workspace_id = $workspaceId AND cs.id = $sessionId`, {
    bind: { workspaceId, sessionId, abandonMinutes: minutes },
    type: QueryTypes.SELECT,
  });
  if (rows.length === 0) throw new NotFoundError('CheckoutSession');
  await ensureTokens(rows);
  return serialize(rows[0]);
}

/**
 * GET /checkout-sessions/stats — the panel above the list, for the period
 * (default: this calendar month): how many checkouts were lost, that against
 * the store's visits, and the money that came back.
 */
async function stats(workspaceId, { from, to } = {}) {
  const minutes = await abandonMinutes(workspaceId);
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  const bind = { workspaceId, abandonMinutes: minutes, start: start.toISOString(), end: end.toISOString() };

  const [reasons, [recovered], [visits], [currencyRow]] = await Promise.all([
    db.sequelize.query(
      `SELECT COALESCE(cs.lost_reason, 'incomplete') AS reason, COUNT(*)::int AS count
         FROM checkout_sessions cs
        WHERE cs.workspace_id = $workspaceId AND ${LOST_SQL}
          AND cs.last_activity_at >= $start::timestamptz AND cs.last_activity_at <= $end::timestamptz
        GROUP BY 1`,
      { bind, type: QueryTypes.SELECT }
    ),
    db.sequelize.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(o.total_amount), 0)::bigint AS amount
         FROM checkout_sessions cs
         JOIN orders o ON o.id = cs.converted_order_id AND o.workspace_id = cs.workspace_id
        WHERE cs.workspace_id = $workspaceId AND cs.recovery_status = 'recovered'
          AND o.created_at >= $start::timestamptz AND o.created_at <= $end::timestamptz`,
      { bind: { workspaceId, start: bind.start, end: bind.end }, type: QueryTypes.SELECT }
    ),
    db.sequelize.query(
      `SELECT COUNT(*)::int AS count
         FROM analytics_sessions s
        WHERE s.workspace_id = $workspaceId
          AND s.created_at >= $start::timestamptz AND s.created_at <= $end::timestamptz`,
      { bind: { workspaceId, start: bind.start, end: bind.end }, type: QueryTypes.SELECT }
    ).catch(() => [{ count: 0 }]),
    db.sequelize.query(`SELECT default_currency AS currency FROM workspaces WHERE id = $workspaceId`, {
      bind: { workspaceId },
      type: QueryTypes.SELECT,
    }),
  ]);

  const byReason = {};
  let lost = 0;
  for (const row of reasons) {
    byReason[row.reason] = row.count;
    lost += row.count;
  }
  return {
    from: bind.start,
    to: bind.end,
    lost,
    byReason,
    visits: visits.count,
    // Lost checkouts per 100 visits, one decimal; null when no visit was recorded.
    lostRate: visits.count > 0 ? Math.round((lost / visits.count) * 1000) / 10 : null,
    recovered: recovered.count,
    recoveredAmount: String(recovered.amount),
    currency: (currencyRow && currencyRow.currency) || 'EGP',
    abandonedAfterMinutes: minutes,
  };
}

/** PATCH /checkout-sessions/:id — the merchant's follow-up (`recoveryStatus`) and/or having dealt with it (`reviewStatus`). */
async function update(workspaceId, sessionId, { recoveryStatus, reviewStatus }, req) {
  await db.sequelize.transaction(async (transaction) => {
    const session = await db.CheckoutSession.findOne({
      where: { id: sessionId, workspaceId },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });
    if (!session) throw new NotFoundError('CheckoutSession');
    const before = { recoveryStatus: session.recoveryStatus, reviewStatus: session.reviewStatus };

    if (recoveryStatus) {
      session.recoveryStatus = recoveryStatus;
      // 'contacted' stamps contacted_at the first time only.
      if (recoveryStatus === 'contacted' && !session.contactedAt) session.contactedAt = new Date();
      // Reaching out is dealing with it.
      if (!reviewStatus && recoveryStatus !== 'not_contacted') session.reviewStatus = 'completed';
    }
    if (reviewStatus) session.reviewStatus = reviewStatus;
    await session.save({ transaction });

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'checkout_session.recovery_update',
      entityType: 'CheckoutSession',
      entityId: session.id,
      before,
      after: { recoveryStatus: session.recoveryStatus, reviewStatus: session.reviewStatus },
      req,
      transaction,
    });
  });
  return getOne(workspaceId, sessionId);
}

/**
 * POST /checkout-sessions/:id/convert — the merchant turns a lost order into
 * a real one (source `manual`), through the same createOrder as every order.
 * What the shopper typed is the default; the body may correct the contact,
 * the address, the payment method or the items.
 */
async function convert(workspaceId, sessionId, body, req) {
  const session = await db.CheckoutSession.findOne({ where: { id: sessionId, workspaceId } });
  if (!session) throw new NotFoundError('CheckoutSession');
  const converted = () => new AppError('CHECKOUT_SESSION_CONVERTED', 'This checkout already became an order', 409);
  if (session.status === 'converted') throw converted();
  const payload = session.checkoutPayload || {};
  const stored = session.contactFields || {};

  const contact = { ...(payload.contact || {}), ...stored, ...(body.contact || {}) };
  // The list showed a masked number (lostOrderPhones.js): sent back unchanged, it means the captured one.
  if (require('./lostOrderPhones').isMasked(contact.phone)) contact.phone = require('./lostOrderPhones').phoneOf(session);
  if (!contact.fullName) throw new ValidationError([{ field: 'contact.fullName', message: 'The customer name is required' }]);
  if (!contact.phone) throw new ValidationError([{ field: 'contact.phone', message: 'The phone number is required' }]);
  const shippingAddress = body.shippingAddress || payload.shippingAddress || null;
  if (!shippingAddress) {
    throw new ValidationError([{ field: 'shippingAddress', message: 'A shipping address is required to place the order' }]);
  }
  const items =
    body.items ||
    (Array.isArray(payload.items) && payload.items.length ? payload.items : null) ||
    (session.items || []).map((line) => ({ variantId: line.variantId, quantity: line.quantity }));
  if (!items || items.length === 0) throw new ValidationError([{ field: 'items', message: 'This checkout has no items' }]);

  // One order per checkout, whatever two clicks or two teammates do: the
  // session is claimed (status flipped) before the order is created, by a
  // single conditional update, and given back if the order cannot be made.
  const previous = session.status;
  const [claimed] = await db.CheckoutSession.update(
    { status: 'converted' },
    { where: { id: sessionId, workspaceId, status: { [db.Sequelize.Op.ne]: 'converted' } } }
  );
  if (!claimed) throw converted();

  // eslint-disable-next-line global-require
  const orderService = require('../orders/orderService');
  // The coupon the shopper entered (`discountCode: null` in the body drops it), and the funnel it came from.
  const discountCode = body.discountCode !== undefined ? body.discountCode : payload.discountCode || null;
  let order;
  try {
    ({ order } = await orderService.createOrder(
      workspaceId,
      {
        // The lines keep their custom-field answers when they were not edited here.
        items: items.map((i) => ({
          variantId: i.variantId,
          ...(i.offerId ? { offerId: i.offerId } : {}),
          quantity: i.quantity,
          ...(i.customizations ? { customizations: i.customizations } : {}),
        })),
        contact: {
          fullName: contact.fullName,
          phone: contact.phone,
          ...(contact.alternatePhone ? { alternatePhone: contact.alternatePhone } : {}),
          ...(contact.email ? { email: contact.email } : {}),
        },
        shippingAddress,
        paymentMethod: body.paymentMethod || 'cod',
        ...(body.notes || payload.notes ? { notes: body.notes || payload.notes } : {}),
        ...(discountCode ? { discountCode } : {}),
        ...(payload.funnelId ? { funnelId: payload.funnelId } : {}),
      },
      req,
      // The shopper's photos belong to their visitor id (customerUploads).
      { source: 'manual', customFields: { visitorId: session.visitorId || null } }
    ));
  } catch (err) {
    await db.CheckoutSession.update({ status: previous }, { where: { id: sessionId, workspaceId, status: 'converted', convertedOrderId: null } });
    throw err;
  }
  // The checkout form's extra answers, as the checkout saves them.
  if (payload.formFields) {
    const workspace = await db.Workspace.findByPk(workspaceId);
    await require('../checkout/checkoutForm').saveCheckoutAnswers(order, workspace, payload.formFields);
  }

  await db.sequelize.transaction(async (transaction) => {
    await db.CheckoutSession.update(
      {
        status: 'converted',
        convertedOrderId: order.id,
        recoveryStatus: 'recovered',
        reviewStatus: 'completed',
        awaitingOtp: false,
      },
      { where: { id: sessionId, workspaceId }, transaction }
    );
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'checkout_session.converted',
      entityType: 'CheckoutSession',
      entityId: sessionId,
      after: { orderId: order.id },
      req,
      transaction,
    });
    await outbox.record(transaction, 'checkout.recovered', { workspaceId, checkoutSessionId: sessionId, orderId: order.id });
  });
  return { order: { id: order.id, orderNumber: order.orderNumber }, session: await getOne(workspaceId, sessionId) };
}

/** DELETE /checkout-sessions/:id — a lost order the merchant does not want to see again. Converted ones stay. */
async function remove(workspaceId, sessionId, req) {
  return db.sequelize.transaction(async (transaction) => {
    const session = await db.CheckoutSession.findOne({ where: { id: sessionId, workspaceId }, transaction });
    if (!session) throw new NotFoundError('CheckoutSession');
    if (session.status === 'converted') {
      throw new AppError('CHECKOUT_SESSION_CONVERTED', 'A checkout that became an order cannot be deleted', 409);
    }
    await session.destroy({ transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'checkout_session.deleted',
      entityType: 'CheckoutSession',
      entityId: sessionId,
      before: { lostReason: session.lostReason, phone: session.phoneNormalized },
      req,
      transaction,
    });
    return { success: true };
  });
}

/** POST /checkout-sessions/export — the filtered list as CSV (UTF-8 with BOM, opens in Excel). */
async function exportCsv(workspaceId, filters = {}, opts = {}) {
  const minutes = await abandonMinutes(workspaceId);
  const { conditions, bind } = buildFilters(workspaceId, minutes, filters);
  bind.limit = EXPORT_MAX_ROWS;
  const rows = await db.sequelize.query(
    `${SELECT}
      WHERE ${conditions.join(' AND ')}
      ORDER BY cs.last_activity_at DESC, cs.id DESC
      LIMIT $limit`,
    { bind, type: QueryTypes.SELECT }
  );
  const header = ['Date', 'Status', 'Reason', 'Name', 'Phone', 'Email', 'City', 'Address', 'Products', 'Total', 'Currency', 'Recovery', 'Review', 'Source', 'Order'];
  const lines = [header.join(',')];
  for (const row of rows) {
    const s = serialize(row);
    const address = s.shippingAddress || {};
    lines.push(
      [
        new Date(s.lastActivityAt).toISOString(),
        s.status,
        s.lostReason || '',
        s.customerName,
        opts.maskPhones ? require('../../core/utils/phoneMask').maskPhone(s.phone) : s.phone,
        s.email,
        address.city,
        address.addressLine,
        (s.items || []).map((i) => `${i.productName} × ${i.quantity}`).join(' | '),
        (s.subtotalAmount / 100).toFixed(2),
        s.currency,
        s.recoveryStatus,
        s.reviewStatus,
        s.source,
        s.convertedOrder ? s.convertedOrder.orderNumber : '',
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return { csv: `﻿${lines.join('\r\n')}\r\n`, count: rows.length };
}

// ------------------------------------------------------------- storefront --

/**
 * GET /store/:workspaceId/recover/:token — what the recovery link rebuilds:
 * the cart lines and what the shopper had typed. Opening it counts as the
 * merchant's message having reached them.
 */
async function recover(workspaceId, token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{20,64}$/.test(token)) throw new NotFoundError('Recovery link');
  const session = await db.CheckoutSession.findOne({ where: { workspaceId, recoveryToken: token } });
  if (!session || session.status === 'converted') throw new NotFoundError('Recovery link');

  if (session.recoveryStatus === 'not_contacted') {
    await session.update({ recoveryStatus: 'contacted', contactedAt: session.contactedAt || new Date() });
  }
  const payload = session.checkoutPayload || {};
  const contact = { ...(payload.contact || {}), ...(session.contactFields || {}) };
  const items =
    Array.isArray(payload.items) && payload.items.length
      ? payload.items
      : (session.items || []).map((line) => ({ variantId: line.variantId, quantity: line.quantity }));
  return {
    recovery: {
      contact: { fullName: contact.fullName || null, phone: contact.phone || null, email: contact.email || null },
      shippingAddress: payload.shippingAddress || null,
      items: items.map((i) => ({ variantId: i.variantId, offerId: i.offerId || null, quantity: i.quantity })),
      source: session.source,
      couponCode: payload.discountCode || null,
    },
  };
}

/**
 * Files a refused checkout as a lost order. `refusal` is what the guards and
 * createOrder attach to their errors: `{ lostReason, toLost, awaitingOtp }`.
 * Never throws: the shopper's answer is the refusal itself, whatever happens here.
 */
async function fileRefusal(req, refusal) {
  try {
    const workspace = req.publicWorkspace;
    if (!workspace || !refusal || !refusal.lostReason) return null;
    const body = req.body || {};
    const contact = body.contact || {};
    const rawPhone = contact.phone ? String(contact.phone) : '';
    const phoneNormalized = normalizePhone(rawPhone) || rawPhone.replace(/\D/g, '').slice(0, 32) || 'unknown';

    // The order's lines: the cart the token names, else the single "Buy now" item.
    let items = [];
    const cartToken = req.headers['x-cart-token'];
    if (cartToken) {
      const cart = await db.Cart.findOne({
        where: { workspaceId: workspace.id, guestToken: cartToken, status: 'active' },
        include: [{ model: db.CartItem, as: 'items' }],
      });
      if (cart && cart.items) {
        items = cart.items.map((i) => ({ variantId: i.variantId, offerId: i.offerId || undefined, quantity: i.quantity, customizations: i.customizations || undefined }));
      }
    }
    // A "Buy now" and the lines added beside it; each keeps the shopper's custom-field answers for "Convert to order".
    if (items.length === 0 && body.item) {
      items = [body.item, ...(Array.isArray(body.extraItems) ? body.extraItems : [])]
        .filter((line) => line && line.variantId)
        .map((line) => ({ variantId: line.variantId, offerId: line.offerId, quantity: line.quantity || 1, customizations: line.customizations || undefined }));
    }

    // eslint-disable-next-line global-require
    const { priceLine } = require('../orders/orderService');
    const snapshot = [];
    const totals = [];
    let currency = workspace.defaultCurrency || 'EGP';
    for (const item of items) {
      try {
        const line = await priceLine(workspace.id, item);
        snapshot.push({
          productId: line.productId,
          variantId: line.variantId,
          productName: line.productName,
          options: line.variantOptions,
          offerName: line.offerName,
          quantity: line.quantity,
          lineTotalAmount: Number(line.lineTotalAmount),
        });
        totals.push(line.lineTotalAmount);
        currency = line.currency;
      } catch (_) {
        // A line that cannot be priced any more is left out of the snapshot.
      }
    }

    const visitor = await visitorGate.describeVisitor(req);
    const values = {
      contactFields: { fullName: contact.fullName || null, phone: rawPhone || null, email: contact.email || null },
      phoneNormalized,
      lostReason: refusal.lostReason,
      awaitingOtp: Boolean(refusal.awaitingOtp),
      // `block` refusals are filed for the record; the others wait for the merchant.
      reviewStatus: refusal.toLost || refusal.awaitingOtp ? 'under_review' : 'completed',
      checkoutPayload: {
        contact,
        shippingAddress: body.shippingAddress || null,
        items,
        paymentMethod: body.paymentMethod || null,
        notes: body.notes || null,
        discountCode: body.discountCode || null,
        funnelId: body.funnelId || null,
        // The checkout form's extra answers (checkout/checkoutForm.js), saved on the converted order.
        formFields: body.formFields || null,
      },
      ipAddress: visitor.ip,
      ipCountry: visitor.ipCountry,
      source: body.funnelId ? 'funnel' : 'store',
      lastActivityAt: new Date(),
      ...(snapshot.length ? { items: snapshot, subtotalAmount: add(...totals), currency } : {}),
    };

    let session = null;
    if (isUuid(body.checkoutSessionId)) {
      session = await db.CheckoutSession.findOne({ where: { id: body.checkoutSessionId, workspaceId: workspace.id, status: 'in_progress' } });
    }
    const visitorId = req.headers['x-visitor-id'];
    if (!session && typeof visitorId === 'string' && visitorId.length >= 8) {
      session = await db.CheckoutSession.findOne({ where: { workspaceId: workspace.id, visitorId: visitorId.slice(0, 64), status: 'in_progress' } });
    }
    if (!session && phoneNormalized !== 'unknown') {
      // A second refusal of the same shopper updates their open lost order instead of stacking another.
      session = await db.CheckoutSession.findOne({
        where: { workspaceId: workspace.id, phoneNormalized, status: 'in_progress', lostReason: refusal.lostReason },
        order: [['lastActivityAt', 'DESC']],
      });
    }
    if (session) {
      await session.update({ ...values, recoveryToken: session.recoveryToken || newToken() });
    } else {
      session = await db.CheckoutSession.create({ workspaceId: workspace.id, ...values, recoveryToken: newToken() });
    }

    // A shopper typing their code is not lost yet; the abandoned sweep picks them up if they never do.
    if (!refusal.awaitingOtp) {
      await outbox.record(null, 'lost_order.created', { workspaceId: workspace.id, checkoutSessionId: session.id, lostReason: refusal.lostReason });
    }
    return session.id;
  } catch (err) {
    logger.error('Could not file a refused checkout as a lost order', { message: err.message });
    return null;
  }
}

/**
 * An online order whose payment never arrived and was cancelled
 * (payments/onlinePaymentService.expireOrder): filed as a lost order with
 * reason `payment_failed`, carrying what the order held, so the merchant can
 * reach the shopper or convert it to cash on delivery. Never throws.
 */
async function fileUnpaidOrder(orderId) {
  try {
    const order = await db.Order.findByPk(orderId);
    if (!order || order.isTest) return null;
    const lines = await db.OrderItem.findAll({ where: { orderId } });
    const contact = order.contactSnapshot || {};
    const rawPhone = contact.phone ? String(contact.phone) : '';
    const phoneNormalized = normalizePhone(rawPhone) || rawPhone.replace(/\D/g, '').slice(0, 32) || 'unknown';
    const context = order.completionContext || {};
    const values = {
      contactFields: { fullName: contact.fullName || null, phone: rawPhone || null, email: contact.email || null },
      phoneNormalized,
      lostReason: 'payment_failed',
      awaitingOtp: false,
      reviewStatus: 'under_review',
      checkoutPayload: {
        contact,
        shippingAddress: order.shippingAddressSnapshot || null,
        items: lines.filter((l) => l.variantId).map((l) => ({ variantId: l.variantId, offerId: l.offerId || undefined, quantity: l.quantity })),
        paymentMethod: order.paymentMethod,
        notes: order.notes || null,
        unpaidOrderId: order.id,
      },
      items: lines.map((l) => ({
        productId: l.productId,
        variantId: l.variantId,
        productName: l.productNameSnapshot || '',
        options: l.variantOptionsSnapshot || null,
        offerName: l.offerNameSnapshot || null,
        quantity: l.quantity,
        lineTotalAmount: Number(l.lineTotalAmount || 0),
      })),
      subtotalAmount: order.subtotalAmount,
      currency: order.currency,
      ipAddress: order.ipAddress || null,
      ipCountry: order.ipCountry || null,
      source: order.funnelId ? 'funnel' : 'store',
      lastActivityAt: new Date(),
    };

    let session = null;
    if (isUuid(context.checkoutSessionId)) {
      session = await db.CheckoutSession.findOne({ where: { id: context.checkoutSessionId, workspaceId: order.workspaceId, status: 'in_progress' } });
    }
    if (!session && phoneNormalized !== 'unknown') {
      session = await db.CheckoutSession.findOne({
        where: { workspaceId: order.workspaceId, phoneNormalized, status: 'in_progress' },
        order: [['lastActivityAt', 'DESC']],
      });
    }
    if (session) await session.update({ ...values, recoveryToken: session.recoveryToken || newToken() });
    else session = await db.CheckoutSession.create({ workspaceId: order.workspaceId, ...values, recoveryToken: newToken() });

    await outbox.record(null, 'lost_order.created', { workspaceId: order.workspaceId, checkoutSessionId: session.id, lostReason: 'payment_failed' });
    return session.id;
  } catch (err) {
    logger.error('Could not file an unpaid order as a lost order', { orderId, message: err.message });
    return null;
  }
}

/**
 * Error middleware at the end of the storefront checkout route: a refusal
 * (ORDER_REJECTED, OTP_REQUIRED, an invalid phone) leaves a lost order behind,
 * then the error goes on to the shopper unchanged.
 */
// eslint-disable-next-line no-unused-vars
async function captureRefusal(err, req, res, next) {
  const refusal =
    (err && err.refusal) ||
    req.checkoutRefusal ||
    (err && err.code === 'INVALID_PHONE' ? { lostReason: 'invalid_data', toLost: true } : null);
  if (refusal) await fileRefusal(req, refusal);
  next(err);
}

/**
 * After an order converted its sessions (checkoutSessionService.convertForOrder):
 * a session the shopper came back to through a message or the recovery link
 * is announced as recovered. Never throws.
 */
async function afterConversion(workspaceId, order) {
  try {
    const rows = await db.sequelize.query(
      `UPDATE checkout_sessions
          SET awaiting_otp = FALSE, review_status = 'completed', updated_at = now()
        WHERE workspace_id = $workspaceId AND converted_order_id = $orderId
        RETURNING id, recovery_status`,
      { bind: { workspaceId, orderId: order.id }, type: QueryTypes.SELECT }
    );
    for (const row of rows) {
      if (row.recovery_status === 'recovered') {
        await outbox.record(null, 'checkout.recovered', { workspaceId, checkoutSessionId: row.id, orderId: order.id });
      }
    }
  } catch (err) {
    logger.error('Could not finish converting checkout sessions', { workspaceId, orderId: order.id, message: err.message });
  }
}

/**
 * The repeatable job `checkout.detect_abandoned`: emits `checkout.abandoned`
 * once for every session that went quiet past its store's limit, so recovery
 * automations can start. Sessions refused for a reason no message should
 * follow (blocked, bot, country, limits) are skipped.
 */
async function detectAbandoned({ batch = 200 } = {}) {
  const rows = await db.sequelize.query(
    `UPDATE checkout_sessions cs
        SET abandoned_event_at = now(),
            recovery_token = COALESCE(cs.recovery_token, substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 36))
       FROM workspaces w
      WHERE w.id = cs.workspace_id
        AND cs.id IN (
              SELECT c.id FROM checkout_sessions c
                JOIN workspaces cw ON cw.id = c.workspace_id
               WHERE c.status = 'in_progress' AND c.abandoned_event_at IS NULL
                 AND (c.lost_reason IS NULL OR c.lost_reason = ANY($recoverable::varchar[]))
                 AND c.last_activity_at < now() - make_interval(mins => LEAST(1440, GREATEST(5,
                       COALESCE(NULLIF(cw.settings->'fraud_rules'->>'abandoned_after_minutes', '')::int, ${DEFAULT_ABANDON_MINUTES}))))
                 AND c.last_activity_at > now() - interval '7 days'
               ORDER BY c.last_activity_at
               LIMIT $batch
               FOR UPDATE OF c SKIP LOCKED
            )
      RETURNING cs.id, cs.workspace_id`,
    { bind: { batch, recoverable: RECOVERABLE_REASONS }, type: QueryTypes.SELECT }
  );
  for (const row of rows) {
    await outbox.record(null, 'checkout.abandoned', { workspaceId: row.workspace_id, checkoutSessionId: row.id });
  }
  return rows.length;
}

module.exports = {
  LOST_REASONS,
  REVIEW_STATUSES,
  RECOVERY_STATUSES,
  TABS,
  abandonMinutesOf,
  list,
  getOne,
  stats,
  update,
  convert,
  remove,
  exportCsv,
  recover,
  fileRefusal,
  fileUnpaidOrder,
  captureRefusal,
  afterConversion,
  detectAbandoned,
};
