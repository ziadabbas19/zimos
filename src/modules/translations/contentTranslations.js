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
 * steps of published funnels — and the store's header and footer (entity
 * `shell`, below), which are live as soon as they are saved. A text without a
 * translation shows the original.
 */

const TEXT_KEYS = new Set([
  'text', 'alt', 'title', 'label', 'name', 'author', 'heading', 'subheading', 'subtitle', 'kicker', 'sub', 'badge',
  'body', 'quote', 'description', 'desc', 'pain', 'caption', 'question', 'answer', 'placeholder',
  'submitLabel', 'successMessage', 'choiceLabel', 'checkboxLabel', 'ctaLabel', 'buttonLabel', 'cartLabel', 'saveLabel',
  'usLabel', 'themLabel', 'us', 'them',
  // The imported templates' bands (xs_*): their links' and buttons' words, the small line over a
  // heading, a team member's role, a post's date line, the shop band's tools and its fields' hints.
  // (Not `formName`: it names the form in the merchant's sign-ups, whatever the shopper reads.)
  'linkLabel', 'button2Label', 'eyebrow', 'role', 'meta', 'quoteAuthor', 'allLabel', 'searchLabel', 'searchPlaceholder',
  'loadMoreLabel', 'viewLabel', 'openLabel', 'contactPlaceholder', 'messagePlaceholder',
]);
// Lists of plain strings that are shown as they are (a bullet list's items, a band's points, a countdown's units).
const STRING_LIST_KEYS = new Set(['items', 'points', 'countdownLabels']);
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

// --- the header and footer ------------------------------------------------------

/*
 * The store's header and footer (and the announcement in the header) live in
 * the workspace's themeSettings, written by the website editor, not in a page:
 * entity `shell`, the workspace's own id. Their words are the `label`,
 * `title` and `text` strings of themeSettings.header and .footer — the menu
 * and its lists, the header's parts, the announcement's lines, the footer's
 * groups, columns and bottom line — never their colours, sizes, links or ids.
 * Saved settings are live at once, so they need no publishing to be offered.
 */
const SHELL_PARTS = ['header', 'footer'];
const SHELL_TEXT_KEYS = new Set(['label', 'title', 'text']);
// The announcement's lines to rotate through.
const SHELL_LIST_KEYS = new Set(['messages', 'text']);
const SHELL_SKIP_KEYS = new Set(['colors', 'sizes', 'show', 'logo', 'logoImage', 'href', 'id', 'type', 'kind', 'layout', 'width', 'align', 'hide']);

function walkShell(node, visit) {
  if (Array.isArray(node)) {
    node.forEach((child) => walkShell(child, visit));
    return;
  }
  if (!isObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (SHELL_SKIP_KEYS.has(key)) continue;
    if (typeof value === 'string') {
      if (SHELL_TEXT_KEYS.has(key) && value.trim() && value.length <= MAX_TEXT) visit(value, (next) => (node[key] = next));
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === 'string') {
          if (SHELL_LIST_KEYS.has(key) && item.trim() && item.length <= MAX_TEXT) visit(item, (next) => (value[i] = next));
        } else walkShell(item, visit);
      });
    } else if (isObject(value)) walkShell(value, visit);
  }
}

/** The header's and footer's texts, each once, in reading order. */
function shellTextsOf(themeSettings) {
  const seen = new Map();
  if (!isObject(themeSettings)) return seen;
  for (const part of SHELL_PARTS) {
    walkShell(themeSettings[part], (text) => {
      const key = keyOf(text);
      if (!seen.has(key)) seen.set(key, text.trim());
    });
  }
  return seen;
}

/** A copy of themeSettings with the header's and footer's translated texts in place; the rest untouched. */
function translateShell(themeSettings, byKey) {
  if (!isObject(themeSettings) || byKey.size === 0) return themeSettings;
  const copy = { ...themeSettings };
  for (const part of SHELL_PARTS) {
    if (!isObject(themeSettings[part])) continue;
    copy[part] = JSON.parse(JSON.stringify(themeSettings[part]));
    walkShell(copy[part], (text, set) => {
      const next = byKey.get(keyOf(text));
      if (next) set(next);
    });
  }
  return copy;
}

async function liveShell(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'themeSettings'] });
  const texts = shellTextsOf(workspace && workspace.themeSettings);
  return texts.size > 0 ? [{ entityType: 'shell', entityId: workspaceId, label: 'Header and footer', sub: null, texts }] : [];
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

const SOURCES = { page: livePages, funnel: liveFunnels, shell: liveShell };
const sourcesOf = (workspaceId, entityType) => SOURCES[entityType](workspaceId);

/** "type:id:key" of every live text, for the Languages overview's percentages. */
async function wantedFields(workspaceId) {
  const out = [];
  for (const entityType of ['page', 'funnel', 'shell']) {
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
  if (!source) throw new NotFoundError({ page: 'Page', funnel: 'Funnel', shell: 'Header and footer' }[entityType]);
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

/**
 * The public store (GET /store/:ws) with its header and footer in the
 * shopper's language: a copy, so the cached store is never changed. Never
 * throws; a store with no translation for them answers exactly as before.
 */
async function localizeShell(req, store) {
  try {
    if (!store || !isObject(store.themeSettings)) return store;
    const locale = await shopperLocaleFor(req, req.tenant.workspaceId);
    if (!locale) return store;
    const byKey = await translationsFor(req.tenant.workspaceId, 'shell', req.tenant.workspaceId, locale);
    if (byKey.size === 0) return store;
    return { ...store, themeSettings: translateShell(store.themeSettings, byKey) };
  } catch (err) {
    logger.warn('Header and footer could not be localized', { error: err.message });
    return store;
  }
}

// --- routes (inside the translations router: website.edit) --------------------

const uuid = Joi.string().uuid();
const entityType = Joi.string().valid('page', 'funnel', 'shell');
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

module.exports = {
  router,
  textsOf,
  translateTree,
  shellTextsOf,
  translateShell,
  keyOf,
  wantedFields,
  listContent,
  saveContent,
  localizePage,
  localizeFunnelStep,
  localizeShell,
};
