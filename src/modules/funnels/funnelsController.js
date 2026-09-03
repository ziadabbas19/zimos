'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./funnelsService');

// --- funnels ---
const createFunnel = asyncHandler(async (req, res) => {
  const funnel = await service.createFunnel(req.tenant.workspaceId, req.body, req);
  res.status(201).json({ funnel });
});

const listFunnels = asyncHandler(async (req, res) => {
  res.json({ funnels: await service.listFunnels(req.tenant.workspaceId) });
});

const getFunnel = asyncHandler(async (req, res) => {
  res.json(await service.getFunnel(req.tenant.workspaceId, req.params.funnelId));
});

const updateFunnel = asyncHandler(async (req, res) => {
  const funnel = await service.updateFunnel(req.tenant.workspaceId, req.params.funnelId, req.body, req);
  res.json({ funnel });
});

const deleteFunnel = asyncHandler(async (req, res) => {
  res.json(await service.deleteFunnel(req.tenant.workspaceId, req.params.funnelId, req));
});

// --- steps ---
const createStep = asyncHandler(async (req, res) => {
  const step = await service.createStep(req.tenant.workspaceId, req.params.funnelId, req.body, req);
  res.status(201).json({ step });
});

const listSteps = asyncHandler(async (req, res) => {
  res.json({ steps: await service.listSteps(req.tenant.workspaceId, req.params.funnelId) });
});

const getStep = asyncHandler(async (req, res) => {
  res.json({ step: await service.getStep(req.tenant.workspaceId, req.params.funnelId, req.params.stepId) });
});

const updateStep = asyncHandler(async (req, res) => {
  const step = await service.updateStep(
    req.tenant.workspaceId,
    req.params.funnelId,
    req.params.stepId,
    req.body,
    req
  );
  res.json({ step });
});

const deleteStep = asyncHandler(async (req, res) => {
  res.json(await service.deleteStep(req.tenant.workspaceId, req.params.funnelId, req.params.stepId, req));
});

// --- edges ---
const createEdge = asyncHandler(async (req, res) => {
  const edge = await service.createEdge(req.tenant.workspaceId, req.params.funnelId, req.body, req);
  res.status(201).json({ edge });
});

const listEdges = asyncHandler(async (req, res) => {
  res.json({ edges: await service.listEdges(req.tenant.workspaceId, req.params.funnelId) });
});

const updateEdge = asyncHandler(async (req, res) => {
  const edge = await service.updateEdge(
    req.tenant.workspaceId,
    req.params.funnelId,
    req.params.edgeId,
    req.body,
    req
  );
  res.json({ edge });
});

const deleteEdge = asyncHandler(async (req, res) => {
  res.json(await service.deleteEdge(req.tenant.workspaceId, req.params.funnelId, req.params.edgeId, req));
});

// --- publish / revisions / rollback / pause ---
const publishFunnel = asyncHandler(async (req, res) => {
  const { funnel, revision } = await service.publishFunnel(
    req.tenant.workspaceId,
    req.params.funnelId,
    req.user.id,
    req.body.note,
    req
  );
  res.status(201).json({
    funnel,
    revision: {
      id: revision.id,
      revisionNumber: revision.revisionNumber,
      note: revision.note,
      createdAt: revision.createdAt,
    },
  });
});

const listRevisions = asyncHandler(async (req, res) => {
  res.json({ revisions: await service.listRevisions(req.tenant.workspaceId, req.params.funnelId) });
});

const rollback = asyncHandler(async (req, res) => {
  const { funnel, revision } = await service.rollbackToRevision(
    req.tenant.workspaceId,
    req.params.funnelId,
    req.params.revisionId,
    req.user.id,
    req
  );
  res.json({ funnel, rolledBackTo: { id: revision.id, revisionNumber: revision.revisionNumber } });
});

const pause = asyncHandler(async (req, res) => {
  const funnel = await service.pauseFunnel(req.tenant.workspaceId, req.params.funnelId, req.user.id, req);
  res.json({ funnel });
});

const resume = asyncHandler(async (req, res) => {
  const funnel = await service.resumeFunnel(req.tenant.workspaceId, req.params.funnelId, req.user.id, req);
  res.json({ funnel });
});

// --- public runtime ---
const startSession = asyncHandler(async (req, res) => {
  const result = await service.startSession(req.tenant.workspaceId, req.params.funnelRef, req.body);
  res.status(201).json(result);
});

const getSessionStep = asyncHandler(async (req, res) => {
  res.json(await service.getSessionStep(req.tenant.workspaceId, req.params.funnelId, req.params.sessionId));
});

const advance = asyncHandler(async (req, res) => {
  const result = await service.advanceSession(
    req.tenant.workspaceId,
    req.params.funnelId,
    req.params.sessionId,
    req.body,
    req
  );
  res.json(result);
});

module.exports = {
  createFunnel,
  listFunnels,
  getFunnel,
  updateFunnel,
  deleteFunnel,
  createStep,
  listSteps,
  getStep,
  updateStep,
  deleteStep,
  createEdge,
  listEdges,
  updateEdge,
  deleteEdge,
  publishFunnel,
  listRevisions,
  rollback,
  pause,
  resume,
  startSession,
  getSessionStep,
  advance,
};
