'use strict';

const Joi = require('joi');
const { Op, QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { validatePageTree, ALLOWED_ELEMENT_TYPES } = require('../pages/pageTree');
const { isXsType } = require('../pages/xsElements');
const { pageFacts, pageOutline } = require('./pageFacts');

/**
 * The P2 rows of SPEC §19.2 (item 97), on the same job pipeline as the P1
 * features (aiService.js): a schema for what the merchant sends, one for what
 * the provider must answer, the facts the prompt needs read on the server,
 * and — for the store builder — what "Apply" creates.
 *
 *   page_review    a page or funnel step + its last 30 days → score and fixes
 *   ad_creatives   a product → headlines, ad texts and banners over its own photos
 *   store_builder  niche + name + colour → theme, home page, collections, policies
 *   wa_reply       an inbox conversation → the reply an employee can send
 *
 * Everything stays a draft: the review and the ad texts are read and copied,
 * the store builder makes an unpublished page and hidden collections (the
 * theme and the policies are shown for the merchant to switch on), and the
 * suggested reply only fills the inbox's message box.
 */

const HEX = /^#[0-9a-fA-F]{6}$/;

/** The P2 feature specs; `DIALECTS` and `text` come from features.js so both lists stay one. */
function specs(DIALECTS, text) {
  const dialect = Joi.string().valid(...DIALECTS).default('egyptian');
  const url = Joi.string().uri({ scheme: ['http', 'https'] }).max(1000);
  return {
    page_review: {
      prompt: 'page_review.v1',
      input: Joi.object({
        source: Joi.string().valid('page', 'step').required(),
        pageId: Joi.string().uuid().when('source', { is: 'page', then: Joi.required(), otherwise: Joi.forbidden() }),
        funnelId: Joi.string().uuid().when('source', { is: 'step', then: Joi.required(), otherwise: Joi.forbidden() }),
        stepKey: Joi.string().max(100).when('source', { is: 'step', then: Joi.required(), otherwise: Joi.forbidden() }),
        dialect,
      }),
      output: Joi.object({
        score: Joi.number().integer().min(0).max(100).required(),
        summary: text(1200).min(1).required(),
        recommendations: Joi.array()
          .items(Joi.object({ title: text(160).min(1).required(), detail: text(800).allow('').required(), severity: Joi.string().valid('high', 'medium', 'low').required() }))
          .max(12)
          .required(),
      }),
    },
    ad_creatives: {
      prompt: 'ad_creatives.v1',
      input: Joi.object({
        productId: Joi.string().uuid().required(),
        platform: Joi.string().valid('facebook', 'instagram', 'tiktok').default('facebook'),
        angle: text(300).allow('', null),
        dialect,
      }),
      output: Joi.object({
        headlines: Joi.array().items(text(60).min(1)).min(1).max(6).required(),
        primaryTexts: Joi.array().items(text(800).min(1)).min(1).max(5).required(),
        banners: Joi.array()
          .items(
            Joi.object({
              imageUrl: url.required(),
              headline: text(60).min(1).required(),
              subline: text(140).allow('').default(''),
              badge: text(40).allow('').default(''),
              format: Joi.string().valid('square', 'story', 'landscape').default('square'),
            })
          )
          .max(6)
          .default([]),
      }),
    },
    store_builder: {
      prompt: 'store_builder.v1',
      input: Joi.object({
        niche: text(200).min(2).required(),
        storeName: text(200).min(1).required(),
        color: Joi.string().pattern(HEX).default('#2563eb'),
        dialect,
      }),
      output: Joi.object({
        theme: Joi.object({ key: Joi.string().max(40).required(), primaryColor: Joi.string().pattern(HEX).required() }).required(),
        home: Joi.object({ title: text(200).min(1).required(), tree: Joi.object().required() }).required(),
        collections: Joi.array().items(Joi.object({ name: text(120).min(1).required(), description: text(1000).allow('').default('') })).min(1).max(8).required(),
        policies: Joi.object({ shipping: text(6000).min(1).required(), returns: text(6000).min(1).required(), privacy: text(6000).min(1).required() }).required(),
      }),
    },
    wa_reply: {
      prompt: 'wa_reply.v1',
      input: Joi.object({ conversationId: Joi.string().uuid().required(), dialect: Joi.string().valid(...DIALECTS) }),
      output: Joi.object({ reply: text(1000).min(1).required() }),
    },
  };
}

/** Who may ask for a P2 feature beyond the AI routes' own gate (aiRoutes.js). */
const PERMISSION = { wa_reply: 'orders.confirm' };

// --- the request must name things in this store ---------------------------

async function precheck(workspaceId, feature, input) {
  if (feature === 'page_review' && input.source === 'page') {
    const page = await db.WebsitePage.findOne({ where: { id: input.pageId, workspaceId }, attributes: ['id'] });
    if (!page) throw new NotFoundError('Page');
  }
  if (feature === 'page_review' && input.source === 'step') {
    const step = await db.FunnelStep.findOne({ where: { workspaceId, funnelId: input.funnelId, key: input.stepKey }, attributes: ['id'] });
    if (!step) throw new NotFoundError('Funnel step');
  }
  if (feature === 'ad_creatives') {
    const product = await db.Product.findOne({ where: { id: input.productId, workspaceId }, attributes: ['id'] });
    if (!product) throw new NotFoundError('Product');
  }
  if (feature === 'wa_reply') {
    const conversation = await db.WhatsappConversation.findOne({ where: { id: input.conversationId, workspaceId }, attributes: ['id'] });
    if (!conversation) throw new NotFoundError('Conversation');
    const lastIn = await db.WhatsappMessage.findOne({ where: { workspaceId, conversationId: input.conversationId, direction: 'in' }, attributes: ['id'] });
    if (!lastIn) throw new AppError('AI_NOTHING_TO_ANSWER', 'The customer has not written anything to answer yet', 422);
  }
}

// --- what the prompt needs, read on the server ----------------------------

const gone = (what) => {
  const err = new Error(`The ${what} no longer exists`);
  err.permanent = true;
  return err;
};

/** Views, visitors and orders of a store page over the last 30 days (the store's own analytics). */
async function pageMetrics(workspaceId, pagePath) {
  const paths = [pagePath, `/store/${workspaceId}${pagePath === '/' ? '' : pagePath}`];
  const [row] = await db.sequelize.query(
    `SELECT COUNT(*) FILTER (WHERE event_name = 'page_view' AND url_path IN (:paths)) AS views,
            COUNT(DISTINCT visitor_id) FILTER (WHERE event_name = 'page_view' AND url_path IN (:paths)) AS visitors,
            COUNT(*) FILTER (WHERE event_name = 'purchase' AND split_part(landing_page, '?', 1) IN (:paths)) AS orders
       FROM analytics_events
      WHERE workspace_id = :workspaceId AND created_at >= NOW() - INTERVAL '30 days'`,
    { replacements: { workspaceId, paths }, type: QueryTypes.SELECT }
  );
  return { views: Number(row.views), visitors: Number(row.visitors), ordersFromVisitorsWhoLandedHere: Number(row.orders) };
}

/** A funnel step's views and visitors over the last 30 days (the runtime tags its page views with the step key). */
async function stepMetrics(workspaceId, funnelId, stepKey) {
  const where = {
    workspaceId,
    funnelId,
    eventName: 'page_view',
    createdAt: { [Op.gte]: new Date(Date.now() - 30 * 86400000) },
    [Op.and]: [db.sequelize.where(db.sequelize.literal("metadata->>'stepKey'"), stepKey)],
  };
  const [views, visitors] = await Promise.all([
    db.AnalyticsEvent.count({ where }),
    db.AnalyticsEvent.count({ where, distinct: true, col: 'visitor_id' }),
  ]);
  return { views, visitors };
}

async function reviewContext(job) {
  const { workspaceId, input } = job;
  let tree;
  let name;
  let metrics;
  let pageKind;
  if (input.source === 'page') {
    const page = await db.WebsitePage.findOne({ where: { id: input.pageId, workspaceId } });
    if (!page) throw gone('page');
    // What the merchant is editing now; the live version when there is no draft.
    tree = page.draftData && Array.isArray(page.draftData.sections) && page.draftData.sections.length ? page.draftData : page.publishedData;
    name = page.title || page.path;
    pageKind = 'store page';
    metrics = await pageMetrics(workspaceId, page.path);
  } else {
    const step = await db.FunnelStep.findOne({ where: { workspaceId, funnelId: input.funnelId, key: input.stepKey } });
    if (!step) throw gone('funnel step');
    tree = step.builderData;
    name = step.name;
    pageKind = `funnel ${step.stepType} step`;
    metrics = await stepMetrics(workspaceId, input.funnelId, input.stepKey);
  }
  return { pageKind, pageName: name, metrics, facts: pageFacts(tree), outline: pageOutline(tree) };
}

async function adContext(job) {
  const product = await db.Product.findOne({
    where: { id: job.input.productId, workspaceId: job.workspaceId },
    include: [{ model: db.ProductVariant, as: 'variants', attributes: ['priceAmount', 'compareAtAmount', 'currency'], required: false }],
  });
  if (!product) throw gone('product');
  const { formatAmount } = require('../automations/automationContext');
  const variants = product.variants || [];
  const cheapest = variants.reduce((best, v) => (best === null || Number(v.priceAmount) < Number(best.priceAmount) ? v : best), null);
  const images = (Array.isArray(product.media) ? product.media : []).map((m) => m && (m.url || m.src)).filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, 8);
  const cms = product.cms || {};
  return {
    product: {
      name: product.name,
      description: String(product.description || '').slice(0, 800),
      price: cheapest ? formatAmount(Number(cheapest.priceAmount), cheapest.currency) : null,
      compareAtPrice: cheapest && cheapest.compareAtAmount ? formatAmount(Number(cheapest.compareAtAmount), cheapest.currency) : null,
      specialOfferText: product.specialOfferText || '',
      features: Array.isArray(cms.features) ? cms.features.map((f) => f.title).filter(Boolean).slice(0, 6) : [],
      images,
    },
  };
}

async function storeContext() {
  const themes = await db.Theme.findAll({ where: { isActive: true, priceAmount: null }, order: [['position', 'ASC']], attributes: ['key', 'name', 'category'] });
  return {
    themes: themes.map((t) => ({ key: t.key, name: (t.name && (t.name.en || t.name.ar)) || t.key, category: t.category })),
    // Not the imported templates' bands: only a template's own look draws them (pages/xsElements.js).
    allowedElements: [...ALLOWED_ELEMENT_TYPES].filter((type) => !isXsType(type)),
  };
}

async function replyContext(job) {
  const conversation = await db.WhatsappConversation.findOne({ where: { id: job.input.conversationId, workspaceId: job.workspaceId } });
  if (!conversation) throw gone('conversation');
  const workspace = await db.Workspace.findByPk(job.workspaceId);
  const { settingsOf } = require('../whatsapp/bot/botService');
  const settings = { ...settingsOf(workspace), ...(job.input.dialect ? { dialect: job.input.dialect } : {}) };
  const brain = await require('../whatsapp/bot/botBrain').contextFor(workspace, settings, conversation);
  const messages = await db.WhatsappMessage.findAll({
    where: { workspaceId: job.workspaceId, conversationId: conversation.id },
    order: [['createdAt', 'DESC']],
    limit: 12,
    attributes: ['direction', 'body', 'templateName'],
  });
  const history = messages.reverse();
  const lastIn = [...history].reverse().find((m) => m.direction === 'in');
  const lines = (list) => (list.length ? list.join('\n') : '—');
  return {
    storeName: workspace.name,
    dialect: settings.dialect || 'egyptian',
    facts: lines([brain.store.extraInfo, brain.store.shipping, brain.store.returns, brain.store.cod].filter(Boolean)),
    products: lines(brain.products.map((p) => `${p.name} — ${p.price} — ${p.inStock ? 'in stock' : 'out of stock'}`)),
    orders: lines(brain.orders.map((o) => `${o.number} — ${o.status} — ${o.total}`)),
    history: lines(history.map((m) => `${m.direction === 'in' ? 'Customer' : 'Store'}: ${m.body || (m.templateName ? `[template ${m.templateName}]` : '')}`)),
    // For a provider that wants the facts as data (the sandbox does).
    lastMessage: lastIn ? lastIn.body || '' : '',
    brain,
  };
}

const CONTEXT = { page_review: reviewContext, ad_creatives: adContext, store_builder: storeContext, wa_reply: replyContext };

// --- checks beyond the schema ---------------------------------------------

const unusable = (message) => {
  const err = new Error(message);
  err.permanent = true;
  return err;
};

/** The answer, cleaned; throws (permanently) when it cannot be used. */
function checkOutput(feature, value, context) {
  if (feature === 'ad_creatives' && context && context.product) {
    // A banner sits on one of the product's own pictures — never an address the model made up.
    // A product without pictures gets the texts only.
    const own = new Set(context.product.images);
    const banners = value.banners.filter((b) => own.has(b.imageUrl));
    if (own.size > 0 && banners.length === 0) throw unusable('The AI answer had no banner on the product’s own pictures');
    return { ...value, banners };
  }
  if (feature === 'store_builder') {
    try {
      validatePageTree(value.home.tree, { requireContent: true, label: 'generated home page' });
    } catch (cause) {
      const detail = cause.details && cause.details[0] ? `${cause.details[0].field}: ${cause.details[0].message}` : cause.message;
      throw unusable(`The AI answer was not a valid page (${detail})`);
    }
  }
  return value;
}

// --- apply ----------------------------------------------------------------

/**
 * The store builder's draft: hidden collections and an unpublished home page
 * (a new page — the store's own home is left alone). The theme and the
 * policies are switched on by the merchant from the result.
 */
async function applyStore(workspaceId, job, body, req) {
  const website = await db.Website.findOne({ where: { workspaceId }, order: [['updatedAt', 'DESC']] });
  if (!website) throw new AppError('WEBSITE_REQUIRED', 'Create your store website first, then add the page to it', 409);
  const pages = require('../pages/pagesService');
  const catalog = require('../catalog/catalogService');
  const page = await pages.createPage(
    workspaceId,
    website.id,
    { path: pages.normalizePath(body.path || `ai-home-${String(job.id).slice(0, 8)}`), title: job.output.home.title, pageType: 'custom', draftData: job.output.home.tree },
    req
  );
  const collectionIds = [];
  for (const c of job.output.collections) {
    const collection = await catalog.createCollection(workspaceId, { name: c.name, description: c.description || null, hidden: true }, req);
    collectionIds.push(collection.id);
  }
  return { type: 'store', pageId: page.id, websiteId: website.id, path: page.path, collectionIds };
}

const APPLY = { store_builder: applyStore };

module.exports = { specs, PERMISSION, precheck, CONTEXT, checkOutput, APPLY };
