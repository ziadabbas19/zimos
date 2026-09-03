'use strict';

const asyncHandler = require('express-async-handler');
const service = require('./waybillService');
const db = require('../../db/models');

const waybill = asyncHandler(async (req, res) => {
  const workspaceId = req.tenant.workspaceId;
  const pdf = await service.generateWaybillPdf(workspaceId, req.params.orderId);

  // Filename uses the order number (always present); harmless extra lookup.
  const order = await db.Order.findOne({ where: { id: req.params.orderId, workspaceId }, attributes: ['orderNumber'] });
  const name = order ? order.orderNumber : req.params.orderId;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="waybill-${name}.pdf"`);
  res.setHeader('Content-Length', pdf.length);
  res.send(pdf);
});

module.exports = { waybill };
