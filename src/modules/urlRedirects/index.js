'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const { Op } = require('sequelize');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { resolvePublicWorkspace } = require('../../core/middleware/publicWorkspace');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const logger = require('../../core/utils/logger');
const { requireStoreFeature, storeFeatureOn } = require('../../core/middleware/storeFeatures');

/*
 * URL redirects. The store's list of old path → new
 * path (301 permanent or 302 temporary). The storefront asks
 * GET /store/:ws/redirects/lookup?path=… on a page it cannot find and
 * sends the shopper on. Paths are store-relative ("/old-page", query kept
 * when the merchant wrote one); a target may also be a full https URL.
 *
 * - When a product's or collection's slug changes, a redirect from the old
 *   address to the new one is added by itself (source 'auto'); redirects
 *   that pointed at the old address are pointed at the new one (no chains),
 *   and a redirect away from the new address is removed (the page exists).
 * - A redirect may not point at itself or close a loop.
 * - CSV import (from,to[,code]) for a move from another platform.
 * - Off (STORE_FEATURES without url_redirects): the routes answer 404 and a
 *   slug change adds no redirect.
 */

const MAX_IMPORT = 5000;
const PATH = /^\/[^\s]*$/;

/** "/a/b/?x" → "/a/b?x": one trailing slash dropped, the query kept. */
function normalize(p) {
  let s = String(p || '').trim();
  try {
    s = decodeURI(s);
  } catch {
    /* keep as typed */
  }
  if (/^https?:\/\//i.test(s)) {
    // A malformed address is no path: the import reports that line, a lookup finds nothing.
    let u;
    try {
      u = new URL(s);
    } catch {
      return '';
    }
    s = `${u.pathname}${u.search}`;
  }
  const [path, query] = s.split('?');
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return query ? `${clean}?${query}` : clean;
}
const isFullUrl = (s) => {
  if (!/^https:\/\/[^\s]+$/i.test(String(s || ''))) return false;
  // One that doesn't parse is refused like any bad line, not stored.
  try {
    new URL(s); // eslint-disable-line no-new
    return true;
  } catch {
    return false;
  }
};

async function assertNoLoop(workspaceId, from, to, ignoreId = null) {
  if (isFullUrl(to)) return;
  if (to === from) throw new ValidationError([{ field: 'toPath', message: 'A redirect cannot point at itself' }]);
  let next = to;
  for (let i = 0; i < 10; i += 1) {
    const r = await db.UrlRedirect.findOne({ where: { workspaceId, fromPath: next, ...(ignoreId ? { id: { [Op.ne]: ignoreId } } : {}) } });
    if (!r) return;
    if (r.toPath === from) throw new ValidationError([{ field: 'toPath', message: 'This would send shoppers round in a loop' }]);
    next = r.toPath;
  }
}

/** A slug changed: old address → new address, and earlier redirects follow. Never throws. */
async function onSlugChange(workspaceId, oldPath, newPath) {
  try {
    if (oldPath === newPath) return;
    await db.UrlRedirect.update({ toPath: newPath }, { where: { workspaceId, toPath: oldPath } });
    await db.UrlRedirect.destroy({ where: { workspaceId, fromPath: newPath } });
    const existing = await db.UrlRedirect.findOne({ where: { workspaceId, fromPath: oldPath } });
    if (existing) await existing.update({ toPath: newPath, statusCode: 301 });
    else await db.UrlRedirect.create({ workspaceId, fromPath: oldPath, toPath: newPath, statusCode: 301, source: 'auto' });
  } catch (err) {
    logger.warn(`[urlRedirects] ${oldPath} → ${newPath}: ${err.message}`);
  }
}

let hooked = false;
function install() {
  if (hooked) return;
  hooked = true;
  db.Product.addHook('afterUpdate', 'zimosSlugRedirect', (p) => {
    if (!storeFeatureOn('url_redirects') || !p.changed('slug') || !p.previous('slug')) return;
    onSlugChange(p.workspaceId, `/products/${p.previous('slug')}`, `/products/${p.slug}`);
  });
  db.Collection.addHook('afterUpdate', 'zimosSlugRedirect', (c) => {
    if (!storeFeatureOn('url_redirects') || !c.changed('slug') || !c.previous('slug')) return;
    onSlugChange(c.workspaceId, `/products?collection=${c.previous('slug')}`, `/products?collection=${c.slug}`);
  });
}
install();

// ----------------------------------------------------------------- routes --

const view = (r) => ({ id: r.id, fromPath: r.fromPath, toPath: r.toPath, statusCode: r.statusCode, source: r.source, hits: r.hits, lastHitAt: r.lastHitAt, createdAt: r.createdAt });

// Mounted at /api/v1/workspaces/:workspaceId/redirects.
const staff = Router({ mergeParams: true });
staff.use(requireStoreFeature('url_redirects'));
staff.use(authenticate, resolveTenant);
const ws = { workspaceId: Joi.string().uuid().required() };
const idP = Joi.object({ ...ws, redirectId: Joi.string().uuid().required() });
const canView = requirePermission(PERMISSIONS.WEBSITE_EDIT);
const body = Joi.object({
  fromPath: Joi.string().trim().max(500).pattern(PATH).required(),
  toPath: Joi.alternatives(Joi.string().trim().max(1000).pattern(PATH), Joi.string().trim().max(1000).uri({ scheme: ['https'] })).required(),
  statusCode: Joi.number().valid(301, 302).default(301),
});

staff.get('/', canView, validate({ params: Joi.object(ws), query: Joi.object({ q: Joi.string().trim().max(200), source: Joi.string().valid('manual', 'auto', 'import'), limit: Joi.number().integer().min(1).max(200).default(50), offset: Joi.number().integer().min(0).default(0) }) }), asyncHandler(async (req, res) => {
  const where = { workspaceId: req.tenant.workspaceId };
  if (req.query.source) where.source = req.query.source;
  if (req.query.q) where[Op.or] = [{ fromPath: { [Op.iLike]: `%${req.query.q.replace(/[%_\\]/g, '\\$&')}%` } }, { toPath: { [Op.iLike]: `%${req.query.q.replace(/[%_\\]/g, '\\$&')}%` } }];
  const { rows, count } = await db.UrlRedirect.findAndCountAll({ where, order: [['createdAt', 'DESC']], limit: req.query.limit, offset: req.query.offset });
  res.json({ redirects: rows.map(view), total: count });
}));
staff.post('/', canView, validate({ params: Joi.object(ws), body }), asyncHandler(async (req, res) => {
  const workspaceId = req.tenant.workspaceId;
  const fromPath = normalize(req.body.fromPath);
  const toPath = isFullUrl(req.body.toPath) ? req.body.toPath : normalize(req.body.toPath);
  if (await db.UrlRedirect.count({ where: { workspaceId, fromPath } })) throw new ValidationError([{ field: 'fromPath', message: 'This path already redirects' }]);
  await assertNoLoop(workspaceId, fromPath, toPath);
  const r = await db.UrlRedirect.create({ workspaceId, fromPath, toPath, statusCode: req.body.statusCode, source: 'manual' });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'redirect.create', entityType: 'UrlRedirect', entityId: r.id, after: view(r), req });
  res.status(201).json({ redirect: view(r) });
}));
staff.put('/:redirectId', canView, validate({ params: idP, body }), asyncHandler(async (req, res) => {
  const workspaceId = req.tenant.workspaceId;
  const r = await db.UrlRedirect.findOne({ where: { id: req.params.redirectId, workspaceId } });
  if (!r) throw new NotFoundError('Redirect');
  const fromPath = normalize(req.body.fromPath);
  const toPath = isFullUrl(req.body.toPath) ? req.body.toPath : normalize(req.body.toPath);
  if (await db.UrlRedirect.count({ where: { workspaceId, fromPath, id: { [Op.ne]: r.id } } })) throw new ValidationError([{ field: 'fromPath', message: 'This path already redirects' }]);
  await assertNoLoop(workspaceId, fromPath, toPath, r.id);
  await r.update({ fromPath, toPath, statusCode: req.body.statusCode });
  // Not audited: the store's pages are dropped here (storefrontCache.js, the edge included).
  require('../storefront/storefrontCache').invalidate(workspaceId);
  res.json({ redirect: view(r) });
}));
staff.delete('/:redirectId', canView, validate({ params: idP }), asyncHandler(async (req, res) => {
  const n = await db.UrlRedirect.destroy({ where: { id: req.params.redirectId, workspaceId: req.tenant.workspaceId } });
  if (!n) throw new NotFoundError('Redirect');
  require('../storefront/storefrontCache').invalidate(req.tenant.workspaceId);
  res.status(204).end();
}));
// CSV: from,to[,301|302] per line; a header line is skipped. Existing paths are updated.
staff.post('/import', canView, validate({ params: Joi.object(ws), body: Joi.object({ csv: Joi.string().max(2000000).required() }) }), asyncHandler(async (req, res) => {
  const workspaceId = req.tenant.workspaceId;
  const lines = req.body.csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > MAX_IMPORT + 1) throw new ValidationError([{ field: 'csv', message: `At most ${MAX_IMPORT} lines` }]);
  let created = 0;
  let updated = 0;
  const errors = [];
  for (const [i, line] of lines.entries()) {
    const [a, b, c] = line.split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
    if (i === 0 && /^from/i.test(a)) continue;
    const fromPath = normalize(a);
    const toPath = isFullUrl(b) ? b : normalize(b);
    const statusCode = c === '302' ? 302 : 301;
    if (!PATH.test(fromPath) || !(PATH.test(toPath) || isFullUrl(toPath)) || fromPath.length > 500 || toPath.length > 1000) {
      errors.push({ line: i + 1, message: 'Use /old-path,/new-path' });
      continue;
    }
    try {
      await assertNoLoop(workspaceId, fromPath, toPath);
      const existing = await db.UrlRedirect.findOne({ where: { workspaceId, fromPath } });
      if (existing) {
        await existing.update({ toPath, statusCode });
        updated += 1;
      } else {
        await db.UrlRedirect.create({ workspaceId, fromPath, toPath, statusCode, source: 'import' });
        created += 1;
      }
    } catch (err) {
      errors.push({ line: i + 1, message: (err.details && err.details[0] && err.details[0].message) || err.message });
    }
  }
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'redirect.import', entityType: 'Workspace', entityId: workspaceId, after: { created, updated, errors: errors.length }, req });
  res.json({ created, updated, errors: errors.slice(0, 100) });
}));

// Mounted at /api/v1/store/:workspaceId/redirects — the storefront's not-found page asks here.
const store = Router({ mergeParams: true });
store.use(requireStoreFeature('url_redirects'));
store.get('/lookup', resolvePublicWorkspace, validate({ query: Joi.object({ path: Joi.string().max(1500).required() }) }), asyncHandler(async (req, res) => {
  const workspaceId = req.publicWorkspace.id;
  const full = normalize(req.query.path);
  const bare = full.split('?')[0];
  const r = (await db.UrlRedirect.findOne({ where: { workspaceId, fromPath: full } })) || (full !== bare ? await db.UrlRedirect.findOne({ where: { workspaceId, fromPath: bare } }) : null);
  if (!r) throw new NotFoundError('Redirect');
  db.UrlRedirect.update({ hits: db.sequelize.literal('hits + 1'), lastHitAt: new Date() }, { where: { id: r.id }, hooks: false }).catch(() => {});
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ to: r.toPath, statusCode: r.statusCode });
}));

module.exports = { staff, store, normalize, onSlugChange, install };
