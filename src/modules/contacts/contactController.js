'use strict';
const asyncHandler = require('express-async-handler');
const service = require('./contactService');
const forms = require('./formService');
const { forViewer } = require('../../core/utils/phoneMask');

const wsId = (req) => req.tenant.workspaceId;

// Phones in a list are masked for roles without customers.reveal_sensitive, as in the orders list.
const list = asyncHandler(async (req, res) => res.json(forViewer(req, await service.listContacts(wsId(req), req.query))));
const exportCsv = asyncHandler(async (req, res) => {
  const csv = await service.exportContacts(wsId(req), req.query, req);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});
const get = asyncHandler(async (req, res) => res.json(await service.getContact(wsId(req), req.params.customerId)));
const create = asyncHandler(async (req, res) => res.status(201).json({ contact: await service.createContact(wsId(req), req.body, req) }));
const setTags = asyncHandler(async (req, res) => res.json({ tags: await service.setTags(wsId(req), req.params.customerId, req.body.tags, req) }));
const bulkTag = asyncHandler(async (req, res) => res.json(await service.bulkTag(wsId(req), req.body, req)));
const listTags = asyncHandler(async (req, res) => res.json(await service.listTags(wsId(req))));

const listSegments = asyncHandler(async (req, res) => res.json(await service.listSegments(wsId(req))));
const createSegment = asyncHandler(async (req, res) => res.status(201).json({ segment: await service.saveSegment(wsId(req), null, req.body, req) }));
const updateSegment = asyncHandler(async (req, res) => res.json({ segment: await service.saveSegment(wsId(req), req.params.segmentId, req.body, req) }));
const deleteSegment = asyncHandler(async (req, res) => {
  await service.deleteSegment(wsId(req), req.params.segmentId, req);
  res.status(204).end();
});
const previewSegment = asyncHandler(async (req, res) => res.json(forViewer(req, await service.previewSegment(wsId(req), req.body.rules))));

const listForms = asyncHandler(async (req, res) => res.json(await forms.listSubmissions(wsId(req), req.query)));
const markForm = asyncHandler(async (req, res) => res.json({ submission: await forms.markRead(wsId(req), req.params.submissionId, req.body.isRead) }));
const deleteForm = asyncHandler(async (req, res) => {
  await forms.deleteSubmission(wsId(req), req.params.submissionId, req);
  res.status(204).end();
});
const submitForm = asyncHandler(async (req, res) => res.status(201).json(await forms.submit(wsId(req), req.body, req)));

module.exports = {
  list,
  exportCsv,
  get,
  create,
  setTags,
  bulkTag,
  listTags,
  listSegments,
  createSegment,
  updateSegment,
  deleteSegment,
  previewSegment,
  listForms,
  markForm,
  deleteForm,
  submitForm,
};
