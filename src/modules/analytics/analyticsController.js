'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./analyticsService');
const funnelService = require('./funnelAnalyticsService');

const summary = asyncHandler(async (req, res) => {
  res.json({ summary: await service.getSummary(req.tenant.workspaceId, req.query) });
});

const funnels = asyncHandler(async (req, res) => {
  res.json(await funnelService.getFunnelsOverview(req.tenant.workspaceId, req.query));
});

const funnelDetail = asyncHandler(async (req, res) => {
  res.json(await funnelService.getFunnelDetail(req.tenant.workspaceId, req.params.funnelId, req.query));
});

module.exports = { summary, funnels, funnelDetail };

// --- Web analytics (Umami port) --------------------------------------------
const web = require('./webAnalyticsService');

const webStats = asyncHandler(async (req, res) => {
  res.json(await web.getStats(req.tenant.workspaceId, req.query));
});
const webSeries = asyncHandler(async (req, res) => {
  res.json(await web.getSeries(req.tenant.workspaceId, req.query));
});
const webMetrics = asyncHandler(async (req, res) => {
  res.json(await web.getMetrics(req.tenant.workspaceId, req.query));
});
const webWeekly = asyncHandler(async (req, res) => {
  res.json(await web.getWeekly(req.tenant.workspaceId, req.query));
});
const webRealtime = asyncHandler(async (req, res) => {
  res.json(await web.getRealtime(req.tenant.workspaceId, req.query));
});

Object.assign(module.exports, { webStats, webSeries, webMetrics, webWeekly, webRealtime });

// --- Dashboard home and sales by UTM -----------------------------------------
const overviewService = require('./overviewService');
const utmReportService = require('./utmReportService');

const overview = asyncHandler(async (req, res) => {
  res.json({ overview: await overviewService.getOverview(req.tenant.workspaceId, req.query) });
});
const utm = asyncHandler(async (req, res) => {
  res.json({ report: await utmReportService.getUtmReport(req.tenant.workspaceId, req.query) });
});

Object.assign(module.exports, { overview, utm });
