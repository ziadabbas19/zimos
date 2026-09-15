'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./platformAdminService');

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
const listSubscriptions = asyncHandler(async (req, res) => {
  res.json({ subscriptions: await service.listSubscriptions({ status: req.query.status }) });
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

module.exports = {
  listPlans,
  createPlan,
  updatePlan,
  deletePlan,
  listSubscriptions,
  listFlags,
  createFlag,
  updateFlag,
  deleteFlag,
  listAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
};
