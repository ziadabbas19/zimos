'use strict';

const Joi = require('joi');
const { Op } = require('sequelize');
const db = require('../../db/models');
const { LEGAL_KEYS } = require('./storeInfo');

/**
 * General store settings and store-level SEO (SPEC §8.8, §8.9). Four blobs in
 * the workspace settings, each sent whole through PATCH /workspaces/:id:
 *
 *   settings.general            { favicon_url, country, hide_platform_branding }
 *   settings.social_links       { facebook, instagram, tiktok, whatsapp, youtube, snapchat, x }
 *   settings.floating_whatsapp  { enabled, phone, message }
 *   settings.store_seo          { title_template, description, og_image_url, google_site_verification }
 *
 * All of it is public by nature — the storefront reads it back from
 * GET /store/:workspaceId as `general`, `social`, `floatingWhatsapp`, `seo`.
 * Every URL must be http(s): these end up in `href` and `src` attributes.
 */

const SOCIAL_KEYS = ['facebook', 'instagram', 'tiktok', 'whatsapp', 'youtube', 'snapchat', 'x'];

const httpUrl = (max = 1000) =>
  Joi.string()
    .trim()
    .max(max)
    .uri({ scheme: ['http', 'https'] })
    .allow('', null)
    .optional();

const generalSchema = Joi.object({
  favicon_url: httpUrl(),
  country: Joi.string().trim().uppercase().length(2).allow('', null).optional(),
  // "Hide ZIMOS branding": stored on any plan, in effect only while the store
  // has remove_branding (storefront/platformBranding.js). Off unless true.
  hide_platform_branding: Joi.boolean().allow(null).optional(),
});

const socialLinksSchema = Joi.object(Object.fromEntries(SOCIAL_KEYS.map((key) => [key, httpUrl(500)])));

const floatingWhatsappSchema = Joi.object({
  enabled: Joi.boolean().required(),
  // Digits with an optional leading +; the storefront builds the wa.me link.
  phone: Joi.string()
    .trim()
    .pattern(/^\+?[0-9]{8,15}$/)
    .allow('', null)
    .optional(),
  message: Joi.string().trim().max(300).allow('', null).optional(),
});

const storeSeoSchema = Joi.object({
  // "%s" stands for the page's own title, e.g. "%s | My store".
  title_template: Joi.string().trim().max(120).allow('', null).optional(),
  description: Joi.string().trim().max(320).allow('', null).optional(),
  og_image_url: httpUrl(),
  // The content of Google's <meta name="google-site-verification">.
  google_site_verification: Joi.string()
    .trim()
    .max(120)
    .pattern(/^[A-Za-z0-9_-]+$/)
    .allow('', null)
    .optional(),
});

const text = (v) => (typeof v === 'string' ? v.trim() : '');

/** What GET /store/:workspaceId adds for these settings; every key present. */
function publicGeneralSettings(settings) {
  const s = settings || {};
  const general = s.general || {};
  const links = s.social_links || {};
  const wa = s.floating_whatsapp || {};
  const seo = s.store_seo || {};

  const social = {};
  for (const key of SOCIAL_KEYS) {
    if (text(links[key])) social[key] = text(links[key]);
  }
  const phone = text(wa.phone);
  return {
    general: { faviconUrl: text(general.favicon_url) || null, country: text(general.country) || null },
    social,
    floatingWhatsapp: wa.enabled === true && phone ? { phone, message: text(wa.message) } : null,
    seo: {
      titleTemplate: text(seo.title_template).includes('%s') ? text(seo.title_template) : null,
      description: text(seo.description) || null,
      ogImageUrl: text(seo.og_image_url) || null,
      googleSiteVerification: text(seo.google_site_verification) || null,
    },
  };
}

const SITEMAP_PRODUCT_LIMIT = 5000;

/**
 * Every public address of a store, as paths relative to its origin, for the
 * storefront's sitemap.xml: home, the product listing, each active product,
 * the published and active website pages, and the legal policies the store
 * has written, and each category's listing (/products?collection=<slug>, its
 * canonical address). Anything marked noindex, and hidden categories, are left out.
 */
async function storeSitemap(workspace) {
  const workspaceId = workspace.id;
  const entries = [{ path: '/', updatedAt: workspace.updatedAt }, { path: '/products', updatedAt: workspace.updatedAt }];

  const products = await db.Product.findAll({
    // A hidden product (page_settings.hidden) opens by its link only — never in a listing, this one included.
    where: { workspaceId, status: 'active', [Op.and]: [db.sequelize.literal(require('../catalog/productPage').notHiddenSql('"Product"'))] },
    attributes: ['id', 'slug', 'updatedAt', 'seo'],
    order: [['updatedAt', 'DESC']],
    limit: SITEMAP_PRODUCT_LIMIT,
  });
  // A product the merchant hid from search engines (seo.noindex) is left out.
  for (const p of products.filter((x) => !(x.seo && x.seo.noindex === true))) entries.push({ path: `/products/${p.slug || p.id}`, updatedAt: p.updatedAt });

  const collections = await db.Collection.findAll({ where: { workspaceId, hidden: false }, attributes: ['slug', 'seo', 'updatedAt'], order: [['position', 'ASC']] });
  for (const c of collections.filter((x) => !(x.seo && x.seo.noindex === true))) {
    // Raw like the product paths: the storefront encodes the whole path (encodeURI).
    entries.push({ path: `/products?collection=${c.slug}`, updatedAt: c.updatedAt });
  }

  const website = await db.Website.findOne({
    where: { workspaceId, status: 'published', publishedRevisionId: { [Op.ne]: null } },
    order: [['updatedAt', 'DESC']],
  });
  if (website) {
    const revision = await db.WebsiteRevision.findOne({ where: { id: website.publishedRevisionId, websiteId: website.id } });
    const snapPages = revision && revision.snapshot && Array.isArray(revision.snapshot.pages) ? revision.snapshot.pages : [];
    const inactive = new Set(
      (await db.WebsitePage.findAll({ where: { websiteId: website.id, isActive: false }, attributes: ['path'] })).map((r) => r.path)
    );
    for (const page of snapPages) {
      if (page.path === '/' || inactive.has(page.path)) continue;
      if (page.seo && page.seo.noindex === true) continue;
      entries.push({ path: page.path, updatedAt: revision.createdAt });
    }
  }

  const legal = (workspace.settings && workspace.settings.legal) || {};
  for (const key of LEGAL_KEYS) {
    if (text(legal[key])) entries.push({ path: `/policies/${key.replace(/_/g, '-')}`, updatedAt: workspace.updatedAt });
  }

  // The blog's index and published posts (modules/blog).
  entries.push(...(await require('../blog').sitemapEntries(workspace.id)));
  return entries.map((e) => ({ path: e.path, updatedAt: e.updatedAt ? new Date(e.updatedAt).toISOString() : null }));
}

module.exports = {
  SOCIAL_KEYS,
  generalSchema,
  socialLinksSchema,
  floatingWhatsappSchema,
  storeSeoSchema,
  publicGeneralSettings,
  storeSitemap,
};
