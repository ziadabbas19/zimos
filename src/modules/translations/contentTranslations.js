'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { NotFoundError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const logger = require('../../core/utils/logger');

/*
 * Translating the text of the store's pages and of its funnels (SPEC §8.10,
 * §10 "Languages"), beside the product and collection fields in
 * translations.js.
 *
 * What is translated is what a shopper reads in a published page tree: the
 * text props of its elements (headings, paragraphs, button labels, questions
 * and answers, list items…) — never links, images, ids or bound data. Each
 * text is stored in `translations` under its entity (a website page, or a
 * whole funnel) with `field` = a hash of the original text. So the same
 * sentence twice is translated once, moving an element keeps its translation,
 * and an edited sentence shows as untranslated again rather than keeping a
 * translation of words that are gone.
 *
 * Only what is live is offered: the pages of the published website and the
 * steps of published funnels. A text without a translation shows the original.
 */

const TEXT_KEYS = new Set([
  'text', 'alt', 'title', 'label', 'name', 'author', 'heading', 'subheading', 'subtitle', 'kicker', 'sub', 'badge',
  'body', 'quote', 'description', 'desc', 'pain', 'caption', 'question', 'answer', 'placeholder',
  'submitLabel', 'successMessage', 'choiceLabel', 'checkboxLabel', 'ctaLabel', 'buttonLabel', 'cartLabel', 'saveLabel',
  'usLabel', 'themLabel', 'us', 'them',
]);
// Lists of plain strings that are shown as they are (a bullet list's items).
const STRING_LIST_KEYS = new Set(['items']);
// Never text: data the storefront fills in, and how things look.
const SKIP_KEYS = new Set(['bindings', 'style', 'styles', 'responsive', 'visibility']);
const MAX_TEXT = 5000;

const keyOf = (text) => `h${crypto.createHash('sha256').update(text.trim()).digest('hex').slice(0, 40)}`;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Calls `visit(text, set)` for every translatable string of a page tree; `set` replaces it (on a copy). */
function walkTree(node, visit) {
  if (Array.isArray(node)) {
    node.forEach((child) => walkTree(child, visit));
    return;
  }
  if (!isObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'props' && isObject(value) && typeof node.type === 'string') walkProps(value, visit);
    else if (typeof value === 'object') walkTree(value, visit);
  }
}

function walkProps(props, visit) {
  for (const [key, value] of Object.entries(props)) {
    if (SKIP_KEYS.has(key)) continue;
    if (typeof value === 'string') {
      if (TEXT_KEYS.has(key) && value.trim() && value.length <= MAX_TEXT) visit(value, (next) => (props[key] = next));
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === 'string') {
          if (STRING_LIST_KEYS.has(key) && item.trim() && item.length <= MAX_TEXT) visit(item, (next) => (value[i] = next));
        } else if (isObject(item)) {
          if (typeof item.type === 'string' && isObject(item.props)) walkTree(item, visit);
          else walkProps(item, visit);
        }
      });
    } else if (isObject(value)) {
      if (typeof value.type === 'string' && isObject(value.props)) walkTree(value, visit);
      else walkProps(value, visit);
    }
  }
}

/** The tree's texts, each once, in reading order. */
function textsOf(tree) {
  const seen = new Map();
  walkTree(tree, (text) => {
    const key = keyOf(text);
    if (!seen.has(key)) seen.set(key, text.trim());
  });
  return seen;
}

/** A copy of the tree with every text that has a translation in `byKey` replaced. */
function translateTree(tree, byKey) {
  if (!tree || byKey.size === 0) return tree;
  const copy = JSON.parse(JSON.stringify(tree));
  walkTree(copy, (text, set) => {
    const next = byKey.get(keyOf(text));
    if (next) set(next);
  });
  return copy;
}

// --- what is live -------------------------------------------------------------

async function livePages(workspaceId) {
  const website = await db.Website.findOne({
    where: { workspaceId, status: 'published', publishedRevisionId: { [db.Sequelize.Op.ne]: null } },
    order: [['updatedAt', 'DESC']],
  });
  if (!website) return [];
  const revision = await db.WebsiteRevision.findOne({ where: { id: website.publishedRevisionId, websiteId: website.id } });
  const pages = (revision && revision.snapshot && Array.isArray(revision.snapshot.pages) && revision.snapshot.pages) || [];
  return pages
    .filter((p) => p.id)
    .map((p) => {
      const texts = textsOf(p.data);
      if (p.title && p.title.trim()) texts.set(keyOf(p.title), p.title.trim());
      return { entityType: 'page', entityId: p.id, label: p.title || p.path, sub: p.path, texts };
    });
}

async function liveFunnels(workspaceId) {
  const funnels = await db.Funnel.findAll({
    where: { workspaceId, status: 'published' },
    attributes: ['id', 'name', 'publishedRevisionId'],
    order: [['updatedAt', 'DESC']],
  });
  const out = [];
  for (const funnel of funnels) {
    if (!funnel.publishedRevisionId) continue;
    const revision = await db.FunnelRevision.findOne({ where: { id: funnel.publishedRevisionId, funnelId: funnel.id } });
    const steps = (revision && revision.snapshot && revision.snapshot.steps) || [];
    const texts = new Map();
    for (const step of steps) for (const [k, v] of textsOf(step.builderData)) if (!texts.has(k)) texts.set(k, v);
    out.push({ entityType: 'funnel', entityId: funnel.id, label: funnel.name, sub: null, texts });
  }
  return out;
}

const sourcesOf = (workspaceId, entityType) => (entityType === 'page' ? livePages(workspaceId) : liveFunnels(workspaceId));

/** "type:id:key" of every live text, for the Languages overview's percentages. */
async function wantedFields(workspaceId) {
  const out = [];
  for (const entityType of ['page', 'funnel']) {
    for (const source of await sourcesOf(workspaceId, entityType)) {
      for (const key of source.texts.keys()) out.push(`${entityType}:${source.entityId}:${key}`);
    }
  }
  return out;
}

async function listContent(workspaceId, { entityType, locale }) {
  const sources = await sourcesOf(workspaceId, entityType);
  const rows = sources.length
    ? await db.Translation.findAll({
        where: { workspaceId, entityType, locale, entityId: sources.map((s) => s.entityId) },
        attributes: ['entityId', 'field', 'value'],
      })
    : [];
  const done = new Map(rows.map((r) => [`${r.entityId}:${r.field}`, r.value]));
  return sources.map((s) => ({
    entityType,
    entityId: s.entityId,
    label: s.label,
    sub: s.sub,
    texts: [...s.texts].map(([key, source]) => ({ key, source, translation: done.get(`${s.entityId}:${key}`) || '' })),
  }));
}

async function saveContent(workspaceId, { entityType, entityId, locale, texts }, req) {
  const { languagesOf } = require('./translations');
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'defaultLocale', 'settings'] });
  if (locale === languagesOf(workspace).defaultLocale) {
    throw new ValidationError([{ field: 'locale', message: "The store's own language is edited in the builder" }]);
  }
  const source = (await sourcesOf(workspaceId, entityType)).find((s) => s.entityId === entityId);
  if (!source) throw new NotFoundError(entityType === 'page' ? 'Page' : 'Funnel');
  const unknown = Object.keys(texts).filter((k) => !source.texts.has(k));
  if (unknown.length) throw new ValidationError(unknown.map((k) => ({ field: `texts.${k}`, message: 'This text is not on the live page' })));

  await db.sequelize.transaction(async (transaction) => {
    for (const [field, raw] of Object.entries(texts)) {
      const value = typeof raw === 'string' ? raw.trim() : '';
      const where = { workspaceId, entityType, entityId, locale, field };
      if (!value) {
        await db.Translation.destroy({ where, transaction });
        continue;
      }
      const existing = await db.Translation.findOne({ where, transaction });
      if (existing) await existing.update({ value, updatedBy: req.user ? req.user.id : null }, { transaction });
      else await db.Translation.create({ ...where, value, updatedBy: req.user ? req.user.id : null }, { transaction });
    }
    await recordAudit({
      workspaceId,
      actorUserId: req.user ? req.user.id : null,
      action: 'translation.save',
      entityType: 'Translation',
      entityId,
      metadata: { entityType, locale, texts: Object.keys(texts).length },
      req,
      transaction,
    });
  });
  const [item] = (await listContent(workspaceId, { entityType, locale })).filter((i) => i.entityId === entityId);
  return item || null;
}

// --- storefront -------------------------------------------------------------

/**
 * The shopper's language when the store offers it besides its own: their pick
 * (X-Store-Locale), else the store's default for shoppers (shopperDefaultOf);
 * null otherwise.
 */
async function shopperLocaleFor(req, workspaceId) {
  const { TRANSLATION_LOCALES, languagesOf, shopperDefaultOf } = require('./translations');
  const asked = String(req.headers['x-store-locale'] || shopperDefaultOf(req.publicWorkspace)).toLowerCase().split('-')[0];
  if (!TRANSLATION_LOCALES.includes(asked)) return null;
  const workspace = req.publicWorkspace || (await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'defaultLocale', 'settings'] }));
  if (!workspace) return null;
  const { defaultLocale, languages } = languagesOf(workspace);
  return asked !== defaultLocale && languages.includes(asked) ? asked : null;
}

async function translationsFor(workspaceId, entityType, entityId, locale) {
  const rows = await db.Translation.findAll({ where: { workspaceId, entityType, entityId, locale }, attributes: ['field', 'value'] });
  return new Map(rows.map((r) => [r.field, r.value]));
}

/** The public page render data in the shopper's language, in place. Never throws. */
async function localizePage(req, data) {
  try {
    const page = data && data.page;
    if (!page || !page.id) return data;
    const locale = await shopperLocaleFor(req, req.tenant.workspaceId);
    if (!locale) return data;
    const byKey = await translationsFor(req.tenant.workspaceId, 'page', page.id, locale);
    page.tree = translateTree(page.tree, byKey);
    if (page.title && byKey.get(keyOf(page.title))) page.title = byKey.get(keyOf(page.title));
  } catch (err) {
    logger.warn('Page could not be localized', { error: err.message });
  }
  return data;
}

/** A funnel runtime answer ({ step: { tree } }) in the shopper's language, in place. Never throws. */
async function localizeFunnelStep(req, funnelId, payload) {
  try {
    if (!payload || !payload.step || !payload.step.tree || !funnelId) return payload;
    const locale = await shopperLocaleFor(req, req.tenant.workspaceId);
    if (!locale) return payload;
    const byKey = await translationsFor(req.tenant.workspaceId, 'funnel', funnelId, locale);
    payload.step.tree = translateTree(payload.step.tree, byKey);
  } catch (err) {
    logger.warn('Funnel step could not be localized', { error: err.message });
  }
  return payload;
}

// --- routes (inside the translations router: website.edit) --------------------

const uuid = Joi.string().uuid();
const entityType = Joi.string().valid('page', 'funnel');
// Checked when a request comes in: translations.js requires this file while it loads.
const locale = () =>
  Joi.string().custom((value, helpers) => (require('./translations').TRANSLATION_LOCALES.includes(value) ? value : helpers.error('any.only')));
const schemas = {
  list: {
    params: Joi.object({ workspaceId: uuid.required() }),
    query: Joi.object({ entityType: entityType.required(), locale: locale().required() }),
  },
  save: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      entityType: entityType.required(),
      entityId: uuid.required(),
      locale: locale().required(),
      texts: Joi.object().pattern(Joi.string().pattern(/^h[0-9a-f]{40}$/), Joi.string().max(8000).allow('', null)).min(1).max(500).required(),
    }),
  },
};

const router = Router({ mergeParams: true });
router.get(
  '/content',
  validate(schemas.list),
  asyncHandler(async (req, res) => res.json({ items: await listContent(req.tenant.workspaceId, req.query) }))
);
router.put(
  '/content',
  validate(schemas.save),
  asyncHandler(async (req, res) => res.json({ item: await saveContent(req.tenant.workspaceId, req.body, req) }))
);

module.exports = { router, textsOf, translateTree, keyOf, wantedFields, listContent, saveContent, localizePage, localizeFunnelStep };
