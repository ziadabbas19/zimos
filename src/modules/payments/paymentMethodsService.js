'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const env = require('../../config/env');
const { NotFoundError, ValidationError, AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const gateways = require('./gateways');

/**
 * Which payment methods a store offers, in which order.
 *
 * Stored under `workspaces.settings.payment_methods` as an ordered list of
 * `{ id, enabled }`. `id` is 'cod' or '<gateway>:<method>' ('paymob:card',
 * 'paymob:wallet'). A method is AVAILABLE when its gateway is connected and
 * its settings can take it; the stored list only records the merchant's order
 * and on/off switches, so connecting a gateway later needs no migration of
 * this list — a newly available method is appended, switched on unless
 * another gateway already takes that method.
 *
 * One gateway per method: with Paymob and Kashier both connected, the
 * merchant picks which one takes cards and which one takes wallets by
 * switching the other entry off. At most one entry per method may be on
 * (updateForDashboard refuses more), and if a stored list ever has two, the
 * first in the merchant's order is the one shoppers get.
 *
 * What a shopper is offered:
 *   - PAYMENTS_ONLINE_ENABLED off: cash on delivery only, whatever is stored —
 *     exactly the store as it has always been.
 *   - on: every enabled + available method, in the merchant's order. Methods of
 *     a gateway account in TEST mode only in the store preview (a valid
 *     X-Store-Preview token), never to real shoppers.
 *   - never an empty list: if nothing is left, cash on delivery.
 */

const COD = 'cod';

function methodId(provider, method) {
  return `${provider}:${method}`;
}

function parseId(id) {
  if (id === COD) return { provider: null, method: COD };
  const [provider, method] = String(id).split(':');
  return { provider, method };
}

function storedList(workspace) {
  const raw = workspace && workspace.settings && workspace.settings.payment_methods;
  return Array.isArray(raw) ? raw.filter((m) => m && typeof m.id === 'string') : [];
}

/**
 * Every method the store has or could have, merchant order first.
 * Each: { id, provider, method, enabled, available, mode }.
 */
async function allMethods(workspace, accounts = null) {
  const rows = accounts || (await db.PaymentGatewayAccount.findAll({ where: { workspaceId: workspace.id } }));
  const available = new Map([[COD, { provider: null, method: COD, mode: 'live' }]]);
  // The gateway connected first keeps its methods: one connected later is
  // appended switched off for any method already taken.
  const byAge = [...rows].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  for (const account of byAge) {
    if (account.status !== 'active') continue;
    const adapter = gateways.getAdapter(account.providerCode);
    if (!adapter) continue;
    for (const method of adapter.availableMethods(account.settings || {})) {
      available.set(methodId(account.providerCode, method), { provider: account.providerCode, method, mode: account.mode });
    }
  }

  const out = [];
  const seen = new Set();
  for (const entry of storedList(workspace)) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const info = available.get(entry.id);
    const { provider, method } = parseId(entry.id);
    out.push({
      id: entry.id,
      provider: info ? info.provider : provider,
      method: info ? info.method : method,
      enabled: entry.enabled !== false,
      available: Boolean(info),
      mode: info ? info.mode : null,
    });
  }
  for (const [id, info] of available) {
    if (seen.has(id)) continue;
    const taken = info.method !== COD && out.some((m) => m.method === info.method && m.enabled);
    out.push({ id, provider: info.provider, method: info.method, enabled: !taken, available: true, mode: info.mode });
  }
  return out;
}

/**
 * The methods a shopper sees at checkout.
 * @param {boolean} preview  a valid staff preview token came with the request
 */
async function storefrontMethods(workspace, { preview = false } = {}) {
  const codOnly = [{ id: COD, provider: null, method: COD, mode: 'live' }];
  if (!env.payments.onlineEnabled) return codOnly;
  const list = [];
  for (const m of await allMethods(workspace)) {
    if (!m.enabled || !m.available) continue;
    // The merchant's chosen gateway for this method; a test-mode one is not
    // replaced by another gateway for real shoppers.
    if (list.some((x) => x.method === m.method)) continue;
    if (m.mode !== 'live' && !preview) {
      list.push({ id: m.id, provider: m.provider, method: m.method, mode: m.mode, hidden: true });
      continue;
    }
    list.push({ id: m.id, provider: m.provider, method: m.method, mode: m.mode });
  }
  const shown = list.filter((m) => !m.hidden);
  return shown.length > 0 ? shown : codOnly;
}

/** Whether cash on delivery is on offer for this shopper. */
async function codOffered(workspace, { preview = false } = {}) {
  return (await storefrontMethods(workspace, { preview })).some((m) => m.id === COD);
}

/**
 * The storefront method for `paymentMethod` (+ optional provider), or a 422
 * PAYMENT_METHOD_UNAVAILABLE.
 */
async function resolveStorefrontMethod(workspace, { paymentMethod, paymentProvider }, { preview = false } = {}) {
  const offered = await storefrontMethods(workspace, { preview });
  const match = offered.find(
    (m) => m.method === paymentMethod && (!paymentProvider || m.provider === paymentProvider || m.id === COD)
  );
  if (!match) {
    throw new AppError('PAYMENT_METHOD_UNAVAILABLE', 'This payment method is not available for this store right now', 422, [
      { field: 'paymentMethod', message: 'Choose one of the payment methods the store offers' },
    ]);
  }
  return match;
}

async function listForDashboard(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId);
  if (!workspace) throw new NotFoundError('Workspace');
  return { onlineEnabled: env.payments.onlineEnabled, methods: await allMethods(workspace) };
}

/**
 * Replaces the merchant's list: `methods` is the full ordered list of
 * `{ id, enabled }`. Unknown ids are refused; at least one available method
 * must stay on so the store can always take an order.
 */
async function updateForDashboard(workspaceId, { methods }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const workspace = await db.Workspace.findByPk(workspaceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!workspace) throw new NotFoundError('Workspace');

    const problems = [];
    const seen = new Set();
    const onFor = new Map();
    methods.forEach((m, i) => {
      const { provider, method } = parseId(m.id);
      const known =
        m.id === COD || (gateways.getAdapter(provider) && gateways.getAdapter(provider).methods.includes(method));
      if (!known) problems.push({ field: `methods.${i}.id`, message: `Unknown payment method "${m.id}"` });
      if (seen.has(m.id)) problems.push({ field: `methods.${i}.id`, message: `"${m.id}" is listed twice` });
      seen.add(m.id);
      if (known && m.enabled && m.id !== COD) {
        if (onFor.has(method)) {
          problems.push({
            field: `methods.${i}.enabled`,
            message: `Only one gateway can take ${method} payments: switch off "${onFor.get(method)}" or "${m.id}"`,
          });
        } else onFor.set(method, m.id);
      }
    });
    if (problems.length) throw new ValidationError(problems, 'Invalid body');

    const current = await allMethods(workspace);
    const availableIds = new Set(current.filter((m) => m.available).map((m) => m.id));
    if (!methods.some((m) => m.enabled && availableIds.has(m.id))) {
      throw new ValidationError(
        [{ field: 'methods', message: 'Keep at least one available payment method switched on' }],
        'Invalid body'
      );
    }

    const before = storedList(workspace);
    const next = methods.map((m) => ({ id: m.id, enabled: Boolean(m.enabled) }));
    workspace.settings = { ...(workspace.settings || {}), payment_methods: next };
    workspace.changed('settings', true);
    await workspace.save({ transaction });

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'payment_methods.update',
      entityType: 'Workspace',
      entityId: workspaceId,
      before: { payment_methods: before },
      after: { payment_methods: next },
      req,
      transaction,
    });

    return { onlineEnabled: env.payments.onlineEnabled, methods: await allMethods(workspace) };
  });
}

// ------------------------------------------------------------ preview tokens

/**
 * A short-lived token that lets staff see (and pay with) test-mode methods on
 * their own storefront. Stateless: `<payload>.<hmac>`, where payload is
 * base64url JSON { w: workspaceId, exp: epoch seconds } and the HMAC is
 * SHA-256 under the access-token secret with a purpose prefix, so it can never
 * be mistaken for, or turned into, a login token.
 */
const PREVIEW_TTL_SECONDS = 2 * 60 * 60;

function previewSignature(payload) {
  return crypto.createHmac('sha256', env.jwt.accessSecret).update(`payments-preview:${payload}`).digest('base64url');
}

function issuePreviewToken(workspaceId) {
  const exp = Math.floor(Date.now() / 1000) + PREVIEW_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ w: workspaceId, exp })).toString('base64url');
  return { token: `${payload}.${previewSignature(payload)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

function isValidPreviewToken(token, workspaceId) {
  if (typeof token !== 'string' || token.length > 500) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = previewSignature(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { w, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return w === workspaceId && typeof exp === 'number' && exp > Date.now() / 1000;
  } catch (err) {
    return false;
  }
}

/** The request's preview flag, from the X-Store-Preview header. */
function isPreviewRequest(req, workspaceId) {
  return isValidPreviewToken(req.headers['x-store-preview'], workspaceId);
}

module.exports = {
  COD,
  methodId,
  allMethods,
  storefrontMethods,
  codOffered,
  resolveStorefrontMethod,
  listForDashboard,
  updateForDashboard,
  issuePreviewToken,
  isValidPreviewToken,
  isPreviewRequest,
};
