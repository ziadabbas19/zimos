'use strict';

const asyncHandler = require('express-async-handler');
const exportService = require('./orderExportService');
const { recordAudit } = require('../audit/auditService');
const { PERMISSIONS } = require('../../core/security/permissions');
const logger = require('../../core/utils/logger');

const canRevealSensitive = (req) => req.tenant.hasPermission(PERMISSIONS.CUSTOMERS_REVEAL_SENSITIVE);

const columns = asyncHandler(async (req, res) => {
  res.json(exportService.columnCatalogue({ canRevealSensitive: canRevealSensitive(req) }));
});

/** Resolves once `res` can take more, or the client is gone. */
function writeChunk(res, chunk) {
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

/**
 * GET /orders/export — the CSV file. Everything that can refuse the request
 * (range, columns, size) runs before the first byte, so those answers are
 * ordinary JSON errors. Each export is audited: who took which columns of how
 * many orders (the search text itself is not stored, only that there was one).
 */
const exportCsv = asyncHandler(async (req, res) => {
  const { workspaceId } = req.tenant;
  const sensitive = canRevealSensitive(req);
  const plan = await exportService.prepareExport(workspaceId, req.query, { canRevealSensitive: sensitive });

  const { q, ...filters } = plan.filters;
  const keys = plan.columns.map((c) => c.key);
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'order.export',
    entityType: 'Order',
    metadata: {
      rows: plan.total,
      rowPer: plan.rowPer,
      columns: keys,
      contactColumns: keys.filter((k) => exportService.SENSITIVE_COLUMNS.includes(k)),
      filters: { ...filters, sort: plan.sort, search: Boolean(q) },
    },
    req,
  });

  const stamp = plan.asOf.toISOString().slice(0, 10);
  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orders-${stamp}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Export-Rows', String(plan.total));

  try {
    for await (const chunk of exportService.csvChunks(workspaceId, plan)) {
      if (res.destroyed) return;
      await writeChunk(res, chunk);
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) throw err;
    // Part of the file is already out: cut the connection so the download
    // fails visibly instead of ending as a quietly shorter file.
    logger.error('Order export failed mid-stream', { requestId: req.id, message: err.message });
    res.destroy(err);
  }
});

module.exports = { columns, exportCsv };
