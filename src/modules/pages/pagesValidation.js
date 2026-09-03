'use strict';

const Joi = require('joi');

const uuid = Joi.string().uuid();

// A page path / "slug": one or more URL segments, or the site root "/".
// Case and leading/trailing slashes are normalised server-side
// (pagesService.normalizePath); this only rejects clearly invalid input
// (spaces, query strings, dots, protocol-relative "//").
const path = Joi.string()
  .min(1)
  .max(300)
  .pattern(/^\/?[A-Za-z0-9](?:[A-Za-z0-9\-_/]*[A-Za-z0-9])?$/)
  .message('"path" may only contain letters, numbers, hyphens, underscores and "/" separators')
  .messages({ 'string.pattern.base': '"path" may only contain letters, numbers, hyphens, underscores and "/" separators' });

const rootOrPath = Joi.alternatives().try(Joi.string().valid('/'), path);

const seo = Joi.object({
  title: Joi.string().allow('').max(300),
  description: Joi.string().allow('').max(1000),
  image: Joi.string().allow('').max(1000),
  ogTitle: Joi.string().allow('').max(300),
  ogDescription: Joi.string().allow('').max(1000),
  ogImage: Joi.string().allow('').max(1000),
  canonical: Joi.string().allow('').max(1000),
  keywords: Joi.array().items(Joi.string().max(100)),
  noindex: Joi.boolean(),
}).unknown(true);

const styles = Joi.object().unknown(true);

// draftData is deep-validated by pageTree.validatePageTree in the service so
// the shape errors are specific and actionable; here it just has to be present
// and not be silently dropped.
const treeData = Joi.any();

const pageTypeEnum = Joi.string().valid('home', 'product', 'collection', 'static', 'blog_post', 'cart', 'custom');

const createWebsite = {
  params: Joi.object({ workspaceId: uuid.required() }),
  body: Joi.object({
    name: Joi.string().min(1).max(200).required(),
    subdomain: Joi.string()
      .lowercase()
      .min(3)
      .max(63)
      .pattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
      .optional(),
    globalStyles: styles.default({}),
    seo: seo.default({}),
  }),
};

const updateWebsite = {
  params: Joi.object({ workspaceId: uuid.required(), websiteId: uuid.required() }),
  body: Joi.object({
    name: Joi.string().min(1).max(200).optional(),
    globalStyles: styles.optional(),
    seo: seo.optional(),
  }).min(1),
};

const websiteIdParam = {
  params: Joi.object({ workspaceId: uuid.required(), websiteId: uuid.required() }),
};

const createPage = {
  params: Joi.object({ workspaceId: uuid.required(), websiteId: uuid.required() }),
  body: Joi.object({
    path: rootOrPath.required(),
    title: Joi.string().min(1).max(200).required(),
    pageType: pageTypeEnum.default('custom'),
    draftData: treeData.optional(),
    seo: seo.default({}),
  }),
};

const updatePage = {
  params: Joi.object({ workspaceId: uuid.required(), websiteId: uuid.required(), pageId: uuid.required() }),
  body: Joi.object({
    path: rootOrPath.optional(),
    title: Joi.string().min(1).max(200).optional(),
    pageType: pageTypeEnum.optional(),
    draftData: treeData.optional(),
    seo: seo.optional(),
  }).min(1),
};

const pageIdParam = {
  params: Joi.object({ workspaceId: uuid.required(), websiteId: uuid.required(), pageId: uuid.required() }),
};

const publish = {
  params: Joi.object({ workspaceId: uuid.required(), websiteId: uuid.required() }),
  body: Joi.object({
    note: Joi.string().max(300).allow('').optional(),
  }).default({}),
};

const rollback = {
  params: Joi.object({
    workspaceId: uuid.required(),
    websiteId: uuid.required(),
    revisionId: uuid.required(),
  }),
};

// --- public (buyer-facing, no staff auth) ---
const publicGetHome = {
  params: Joi.object({ workspaceId: uuid.required() }),
  query: Joi.object({
    path: Joi.string().max(300).optional(),
    format: Joi.string().valid('json', 'html').optional(), // optional HTML rendering for browsers
  }),
};

const publicGetPage = {
  params: Joi.object({ workspaceId: uuid.required(), slug: Joi.string().max(300).required() }),
  query: Joi.object({ format: Joi.string().valid('json', 'html').optional() }),
};

module.exports = {
  createWebsite,
  updateWebsite,
  websiteIdParam,
  createPage,
  updatePage,
  pageIdParam,
  publish,
  rollback,
  publicGetHome,
  publicGetPage,
};
