'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./platformAdminService');
const systemServices = require('./systemServicesService');
const overviewMetrics = require('./overviewMetricsService');
const templateService = require('../templates/templateService');

// Every handler here sits behind `authenticate` + `requirePlatformAdmin`.
// Collections are returned under a named key, matching the rest of the API.

// --- Plans ---------------------------------------------------------------
const listPlans = asyncHandler(async (req, res) => {
  res.json({ plans: await service.listPlans() });
});

const createPlan = asyncHandler(async (req, res) => {
  res.status(201).json({ plan: await service.savePlan(req.body) });
});

const updatePlan = asyncHandler(async (req, res) => {
  res.json({ plan: await service.savePlan({ ...req.body, id: req.params.planId }) });
});

const deletePlan = asyncHandler(async (req, res) => {
  res.json(await service.deletePlan(req.params.planId));
});

// --- Subscriptions -------------------------------------------------------
// The service returns the full envelope ({ subscriptions, mrr, mrrCurrency,
// mrrByCurrency }) — the total is computed there so the currency check cannot
// be skipped by a caller that only wants the rows.
const listSubscriptions = asyncHandler(async (req, res) => {
  res.json(await service.listSubscriptions({ status: req.query.status }));
});

// --- Overview metrics ----------------------------------------------------
// One object, not a collection, so it takes a named key of its own: the
// console's single-record unwrap requires `overview` and rejects a bare
// object loudly rather than guessing at it.
const getOverview = asyncHandler(async (req, res) => {
  res.json({ overview: await overviewMetrics.getOverview() });
});

// --- Audit log -----------------------------------------------------------
// The service already returns the full envelope ({ auditLog, total, page,
// pageSize }), so this passes it straight through.
const listAuditLog = asyncHandler(async (req, res) => {
  res.json(await service.listAuditLog(req.query));
});

// --- System services -----------------------------------------------------
// Both return the same { services: [...] } envelope and the same tile shape,
// so the console renders them through one path. The GET may serve a reading up
// to CACHE_TTL_MS old; the POST always probes for real.
const listServices = asyncHandler(async (req, res) => {
  res.json(await systemServices.listServices());
});

const checkServices = asyncHandler(async (req, res) => {
  res.json(await systemServices.checkServices());
});

// --- Feature flags -------------------------------------------------------
const listFlags = asyncHandler(async (req, res) => {
  res.json({ featureFlags: await service.listFlags() });
});

const createFlag = asyncHandler(async (req, res) => {
  res.status(201).json({ featureFlag: await service.saveFlag(req.body) });
});

const updateFlag = asyncHandler(async (req, res) => {
  res.json({ featureFlag: await service.saveFlag({ ...req.body, id: req.params.flagId }) });
});

const deleteFlag = asyncHandler(async (req, res) => {
  res.json(await service.deleteFlag(req.params.flagId));
});

// --- Announcements -------------------------------------------------------
const listAnnouncements = asyncHandler(async (req, res) => {
  res.json({ announcements: await service.listAnnouncements() });
});

const createAnnouncement = asyncHandler(async (req, res) => {
  res.status(201).json({ announcement: await service.saveAnnouncement(req.body, req.user.id) });
});

const updateAnnouncement = asyncHandler(async (req, res) => {
  res.json({
    announcement: await service.saveAnnouncement({ ...req.body, id: req.params.announcementId }, req.user.id),
  });
});

const deleteAnnouncement = asyncHandler(async (req, res) => {
  res.json(await service.deleteAnnouncement(req.params.announcementId));
});

// --- Templates -----------------------------------------------------------
// Delegated to the templates module: the public gallery reads the same rows,
// and one module owning what a Template means is what keeps the admin grid and
// the picker from drifting apart. These routes contribute the admin guard.
const listTemplates = asyncHandler(async (req, res) => {
  res.json({ templates: await templateService.listAllTemplates({ kind: req.query.kind }) });
});

const createTemplate = asyncHandler(async (req, res) => {
  res.status(201).json({ template: await templateService.saveTemplate(req.body) });
});

const updateTemplate = asyncHandler(async (req, res) => {
  res.json({ template: await templateService.saveTemplate({ ...req.body, id: req.params.templateId }) });
});

const deleteTemplate = asyncHandler(async (req, res) => {
  res.json(await templateService.deleteTemplate(req.params.templateId));
});

module.exports = {
  listPlans,
  createPlan,
  updatePlan,
  deletePlan,
  listSubscriptions,
  getOverview,
  listAuditLog,
  listServices,
  checkServices,
  listFlags,
  createFlag,
  updateFlag,
  deleteFlag,
  listAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
};
