'use strict';

const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const exportService = require('./orderExportService');
const { recordAudit } = require('../audit/auditService');
const { buildXlsx } = require('./xlsxWriter');
const { AppError } = require('../../core/errors/AppError');

const columns = asyncHandler(async (req, res) => {
  res.json(exportService.columnCatalogue());
});

/** Streams the CSV: a page of orders is written as soon as it is read. */
const exportCsv = asyncHandler(async (req, res) => {
  const { lang, format, ...rest } = req.query;
  // A preset (accepted orders) fixes the columns and adds its filter.
  const { preset, columns: requested, rowPer, filters, fileName } = exportService.applyPreset(rest);
  const { workspaceId } = req.tenant;

  // A preset downloads now only for a short range: past it the dashboard
  // prepares the file in the background (POST /exports/orders).
  if (preset) {
    const tooLarge = await exportService.directTooLarge(workspaceId, filters);
    if (tooLarge) throw new AppError('EXPORT_TOO_LARGE', 'Too many orders to download now: prepare the file in the background', 413, tooLarge);
  }

  // Dates are written on the store's own clock, not the server's.
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['timezone'] });
  const timezone = (workspace && workspace.timezone) || 'UTC';
  // Phones partly hidden, as in the orders list, without customers.reveal_sensitive (SPEC §3.4 #8).
  const maskPhones = !req.tenant.hasPermission('customers.reveal_sensitive');

  // Excel: the same table as one .xlsx document (right-to-left for Arabic).
  if (format === 'xlsx') {
    const rows = await exportService.tableRows(workspaceId, filters, { columns: requested, rowPer, lang, timezone, maskPhones });
    const file = buildXlsx(rows, { sheetName: lang === 'ar' ? 'الأوردرات' : 'Orders', rtl: lang === 'ar' });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'order.export',
      entityType: 'Order',
      metadata: { filters, rowPer, format, columns: requested || 'default', maskedPhones: maskPhones, ...(preset ? { preset } : {}) },
      req,
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', file.length);
    return res.send(file);
  }

  // The first chunk is produced before any header is sent, so a database
  // error still answers as a normal JSON error.
  const chunks = exportService.csvChunks(workspaceId, filters, { columns: requested, rowPer, lang, timezone, maskPhones });
  const first = await chunks.next();

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'order.export',
    entityType: 'Order',
    metadata: { filters, rowPer, format, columns: requested || 'default', maskedPhones: maskPhones, ...(preset ? { preset } : {}) },
    req,
  });

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}-${stamp}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  if (!first.done) res.write(first.value);
  for await (const chunk of chunks) res.write(chunk);
  return res.end();
});

module.exports = { columns, exportCsv };
