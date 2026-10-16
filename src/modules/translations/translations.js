'use strict';

const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const logger = require('../../core/utils/logger');

/**
 * Multi-language content (SPEC §8.10).
 *
 * The store's interface languages are a fixed list; which of them a store
 * offers is `settings.store_languages` (the store's default language is always
 * on). The merchant's own content — product and collection names and
 * descriptions — is translated field by field into the `translations` table.
 * The original always stays on the product or collection; a field with no
 * translation shows the original, so a half-translated store never shows a
 * blank.
 *
 * The storefront says which language the shopper reads in with the
 * `X-Store-Locale` header, and `localize*` lays the translations over the
 * public product and collection answers.
 */

const LOCALES = ['ar', 'en', 'fr', 'es', 'it', 'de'];
const ENTITY_FIELDS = Object.freeze({
  product: ['name', 'description'],
  collection: ['name', 'description'],
});
const MAX_VALUE = 20000;

const storeLanguagesSchema = Joi.array().items(Joi.string().valid(...LOCALES)).max(LOCALES.length).unique();

const baseOf = (locale) => String(locale || '').toLowerCase().split('-')[0];

/** The store's own language and the extra ones it offers. */
function languagesOf(workspace) {
  const defaultLocale = LOCALES.includes(baseOf(workspace.defaultLocale)) ? baseOf(workspace.defaultLocale) : 'ar';
  const stored = Array.isArray(workspace.settings && workspace.settings.store_languages) ? workspace.settings.store_languages : [];
  const extra = stored.filter((l) => LOCALES.includes(l) && l !== defaultLocale);
  return { defaultLocale, languages: [defaultLocale, ...extra] };
}

const blank = (v) => typeof v !== 'string' || v.trim() === '';

async function sourceRows(workspaceId, entityType) {
  if (entityType === 'product') {
    return db.Product.findAll({
      where: { workspaceId, status: 'active' },
      attributes: ['id', 'name', 'description'],
      order: [['createdAt', 'DESC']],
    });
  }
  return db.Collection.findAll({ where: { workspaceId }, attributes: ['id', 'name', 'description'], order: [['name', 'ASC']] });
}

/**
 * How much of the store is translated into each language: every non-empty
 * name and description of an active product or a collection counts as one
 * field. The default language is 100% by definition.
 */
async function overview(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'defaultLocale', 'settings'] });
  if (!workspace) throw new NotFoundError('Workspace');
  const { defaultLocale, languages } = languagesOf(workspace);

  // The fields that exist to translate, as "type:id:field".
  const wanted = new Set();
  for (const entityType of Object.keys(ENTITY_FIELDS)) {
    for (const row of await sourceRows(workspaceId, entityType)) {
      for (const field of ENTITY_FIELDS[entityType]) {
        if (!blank(row[field])) wanted.add(`${entityType}:${row.id}:${field}`);
      }
    }
  }
  // The live pages' and funnels' texts (contentTranslations.js).
  for (const key of await require('./contentTranslations').wantedFields(workspaceId)) wanted.add(key);
  const rows = await db.Translation.findAll({
    where: { workspaceId, locale: languages },
    attributes: ['entityType', 'entityId', 'locale', 'field'],
  });
  const done = new Map(languages.map((l) => [l, 0]));
  for (const r of rows) {
    if (wanted.has(`${r.entityType}:${r.entityId}:${r.field}`)) done.set(r.locale, done.get(r.locale) + 1);
  }
  const total = wanted.size;
  return {
    defaultLocale,
    available: LOCALES,
    totalFields: total,
    languages: languages.map((locale) => {
      const translated = locale === defaultLocale ? total : done.get(locale);
      return {
        locale,
        isDefault: locale === defaultLocale,
        translatedFields: translated,
        // Whole percent; an empty store is "100%" in every language.
        percent: total === 0 ? 100 : Math.floor((translated / total) * 100),
      };
    }),
  };
}

/** The items of one kind with their original text and their translation in `locale`. */
async function listItems(workspaceId, { entityType, locale }) {
  const sources = await sourceRows(workspaceId, entityType);
  const rows = sources.length
    ? await db.Translation.findAll({
        where: { workspaceId, entityType, locale, entityId: sources.map((s) => s.id) },
        attributes: ['entityId', 'field', 'value'],
      })
    : [];
  const byEntity = new Map();
  for (const r of rows) {
    if (!byEntity.has(r.entityId)) byEntity.set(r.entityId, {});
    byEntity.get(r.entityId)[r.field] = r.value;
  }
  return sources.map((s) => ({
    entityType,
    entityId: s.id,
    source: Object.fromEntries(ENTITY_FIELDS[entityType].map((f) => [f, s[f] || ''])),
    translation: Object.fromEntries(ENTITY_FIELDS[entityType].map((f) => [f, (byEntity.get(s.id) || {})[f] || ''])),
  }));
}

/** Saves the given fields of one item in one language; an emptied field goes back to the original. */
async function saveItem(workspaceId, { entityType, entityId, locale, fields }, req) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'defaultLocale', 'settings'] });
  const { defaultLocale } = languagesOf(workspace);
  if (locale === defaultLocale) {
    throw new ValidationError([{ field: 'locale', message: 'The store\'s own language is edited on the item itself' }]);
  }
  const model = entityType === 'product' ? db.Product : db.Collection;
  const entity = await model.findOne({ where: { id: entityId, workspaceId }, attributes: ['id'] });
  if (!entity) throw new NotFoundError(entityType === 'product' ? 'Product' : 'Collection');

  const allowed = ENTITY_FIELDS[entityType];
  const unknown = Object.keys(fields).filter((f) => !allowed.includes(f));
  if (unknown.length) throw new ValidationError(unknown.map((f) => ({ field: `fields.${f}`, message: `"${f}" cannot be translated` })));

  await db.sequelize.transaction(async (transaction) => {
    for (const [field, raw] of Object.entries(fields)) {
      const value = typeof raw === 'string' ? raw.trim() : '';
      const where = { workspaceId, entityType, entityId, locale, field };
      if (!value) {
        await db.Translation.destroy({ where, transaction });
        continue;
      }
      const existing = await db.Translation.findOne({ where, transaction });
      if (existing) await existing.update({ value, updatedBy: req.user.id }, { transaction });
      else await db.Translation.create({ ...where, value, updatedBy: req.user.id }, { transaction });
    }
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'translation.save',
      entityType: 'Translation',
      entityId,
      metadata: { entityType, locale, fields: Object.keys(fields) },
      req,
      transaction,
    });
  });
  const [item] = (await listItems(workspaceId, { entityType, locale })).filter((i) => i.entityId === entityId);
  return item || null;
}

// --- storefront -------------------------------------------------------------

/**
 * The language a shopper who hasn't picked one reads in: the one the merchant
 * chose for shoppers (themeSettings.shopperDisplay.locale, the dashboard's
 * Languages tab), else none — the store's own. A store that never chose reads
 * exactly as before.
 */
function shopperDefaultOf(workspace) {
  const settings = workspace && workspace.themeSettings;
  const display = settings && typeof settings === 'object' ? settings.shopperDisplay : null;
  return display && typeof display === 'object' && typeof display.locale === 'string' ? display.locale : '';
}

/** The language the shopper reads in, when it is one this store offers besides its own. */
async function shopperLocale(req) {
  // The shopper's own pick (X-Store-Locale) wins over the store's default for shoppers.
  const asked = baseOf(req.headers['x-store-locale'] || shopperDefaultOf(req.publicWorkspace));
  if (!LOCALES.includes(asked)) return null;
  const workspace = req.publicWorkspace;
  if (!workspace) return null;
  const { defaultLocale } = languagesOf(workspace);
  return asked === defaultLocale ? null : asked;
}

async function overlay(workspaceId, locale, entityType, items) {
  const list = items.filter((i) => i && i.id);
  if (list.length === 0) return;
  const rows = await db.Translation.findAll({
    where: { workspaceId, entityType, locale, entityId: list.map((i) => i.id) },
    attributes: ['entityId', 'field', 'value'],
  });
  const byId = new Map(list.map((i) => [i.id, i]));
  for (const r of rows) {
    const item = byId.get(r.entityId);
    if (item && ENTITY_FIELDS[entityType].includes(r.field) && r.field in item) item[r.field] = r.value;
  }
}

/**
 * Lays the shopper's language over public products and collections, in place.
 * Never throws: a translation problem must not take the store down, so the
 * originals are served.
 */
async function localizeProducts(req, products) {
  try {
    const locale = await shopperLocale(req);
    if (locale) await overlay(req.tenant.workspaceId, locale, 'product', products);
  } catch (err) {
    logger.warn('Products could not be localized', { error: err.message });
  }
  return products;
}

async function localizeCollections(req, collections) {
  try {
    const locale = await shopperLocale(req);
    if (locale) await overlay(req.tenant.workspaceId, locale, 'collection', collections);
  } catch (err) {
    logger.warn('Collections could not be localized', { error: err.message });
  }
  return collections;
}

// --- routes ---------------------------------------------------------------

const uuid = Joi.string().uuid();
const locale = Joi.string().valid(...LOCALES);
const entityType = Joi.string().valid(...Object.keys(ENTITY_FIELDS));
const schemas = {
  overview: { params: Joi.object({ workspaceId: uuid.required() }) },
  list: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({ entityType: entityType.required(), locale: locale.required() }),
  },
  save: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      entityType: entityType.required(),
      entityId: uuid.required(),
      locale: locale.required(),
      fields: Joi.object().pattern(Joi.string().max(60), Joi.string().max(MAX_VALUE).allow('', null)).min(1).required(),
    }),
  },
};

// Mounted at /api/v1/workspaces/:workspaceId/translations — website.edit.
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.WEBSITE_EDIT));
router.get(
  '/overview',
  validate(schemas.overview),
  asyncHandler(async (req, res) => res.json(await overview(req.tenant.workspaceId)))
);
router.get(
  '/',
  validate(schemas.list),
  asyncHandler(async (req, res) => res.json({ items: await listItems(req.tenant.workspaceId, req.query) }))
);
// Pages and funnels: GET/PUT /content (contentTranslations.js).
router.use(require('./contentTranslations').router);
router.put(
  '/',
  validate(schemas.save),
  asyncHandler(async (req, res) => res.json({ item: await saveItem(req.tenant.workspaceId, req.body, req) }))
);
// "Translate what's missing with AI": POST /ai and /ai/apply (aiFill.js), there only while AI_ENABLED is "true".
router.use(require('../ai/aiGate').whenAiEnabled(require('./aiFill').router));

module.exports = {
  router,
  TRANSLATION_LOCALES: LOCALES,
  storeLanguagesSchema,
  languagesOf,
  shopperDefaultOf,
  overview,
  listItems,
  localizeProducts,
  localizeCollections,
};
