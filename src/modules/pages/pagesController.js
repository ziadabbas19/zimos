'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./pagesService');
const quickstartService = require('../quickstart/quickstartService');

// --- websites ---
const createWebsite = asyncHandler(async (req, res) => {
  const website = await service.createWebsite(req.tenant.workspaceId, req.body, req);
  res.status(201).json({ website });
});

const listWebsites = asyncHandler(async (req, res) => {
  res.json({ websites: await service.listWebsites(req.tenant.workspaceId) });
});

const getWebsite = asyncHandler(async (req, res) => {
  res.json(await service.getWebsite(req.tenant.workspaceId, req.params.websiteId));
});

const updateWebsite = asyncHandler(async (req, res) => {
  const website = await service.updateWebsite(req.tenant.workspaceId, req.params.websiteId, req.body, req);
  res.json({ website });
});

const deleteWebsite = asyncHandler(async (req, res) => {
  res.json(await service.deleteWebsite(req.tenant.workspaceId, req.params.websiteId, req));
});

// --- pages ---
const createPage = asyncHandler(async (req, res) => {
  const page = await service.createPage(req.tenant.workspaceId, req.params.websiteId, req.body, req);
  res.status(201).json({ page });
});

const listPages = asyncHandler(async (req, res) => {
  res.json({ pages: await service.listPages(req.tenant.workspaceId, req.params.websiteId) });
});

const getPage = asyncHandler(async (req, res) => {
  res.json({ page: await service.getPage(req.tenant.workspaceId, req.params.websiteId, req.params.pageId) });
});

const updatePage = asyncHandler(async (req, res) => {
  const page = await service.updatePage(
    req.tenant.workspaceId,
    req.params.websiteId,
    req.params.pageId,
    req.body,
    req
  );
  res.json({ page });
});

const deletePage = asyncHandler(async (req, res) => {
  res.json(await service.deletePage(req.tenant.workspaceId, req.params.websiteId, req.params.pageId, req));
});

// --- publish / revisions / rollback ---
const publishWebsite = asyncHandler(async (req, res) => {
  const { website, revision } = await service.publishWebsite(
    req.tenant.workspaceId,
    req.params.websiteId,
    req.user.id,
    req.body.note,
    req
  );
  res.status(201).json({
    website,
    revision: { id: revision.id, revisionNumber: revision.revisionNumber, note: revision.note, createdAt: revision.createdAt },
  });
});

const listRevisions = asyncHandler(async (req, res) => {
  res.json({ revisions: await service.listRevisions(req.tenant.workspaceId, req.params.websiteId) });
});

const rollback = asyncHandler(async (req, res) => {
  const { website, revision } = await service.rollbackToRevision(
    req.tenant.workspaceId,
    req.params.websiteId,
    req.params.revisionId,
    req.user.id,
    req
  );
  res.json({
    website,
    rolledBackTo: { id: revision.id, revisionNumber: revision.revisionNumber },
  });
});

// --- public render-data API ---
const publicGetPage = asyncHandler(async (req, res) => {
  const rawPath = req.params.slug != null ? `/${req.params.slug}` : req.query.path || '/';
  const result = await service.getPublishedPageForStore(req.tenant.workspaceId, rawPath);
  if (result.kind === 'redirect') {
    res.set('Location', result.to);
    return res.status(result.statusCode).json({ redirect: { to: result.to, statusCode: result.statusCode } });
  }
  // Optionally render HTML for a browser (?format=html, or an HTML-preferring
  // Accept header). Default is JSON. HTML renders the store home.
  const wantsHtml = req.query.format === 'html' || req.accepts(['json', 'html']) === 'html';
  if (wantsHtml) {
    res.removeHeader('Content-Security-Policy');
    return res.render('store-home', await quickstartService.storeHomeLocals(req.tenant.workspaceId));
  }
  return res.json(result.data);
});

module.exports = {
  createWebsite,
  listWebsites,
  getWebsite,
  updateWebsite,
  deleteWebsite,
  createPage,
  listPages,
  getPage,
  updatePage,
  deletePage,
  publishWebsite,
  listRevisions,
  rollback,
  publicGetPage,
};
