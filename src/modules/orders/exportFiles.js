'use strict';

const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const queue = require('../../core/queue');
const { NotFoundError, AppError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { getStorage } = require('../media/storage');
const exportService = require('./orderExportService');
const { buildXlsx } = require('./xlsxWriter');

/**
 * The orders export as SPEC §4.3 has it: the file is built in the `io`
 * queue, kept in private storage, and its link reaches the teammate who
 * asked as an `export.ready` notification (the bell, and email). The link
 * opens /exports/:id in the dashboard, which downloads it with the
 * teammate's own session — the file is never public.
 *
 * Only the teammate who asked sees and downloads it. Files are kept for
 * KEEP_DAYS, then the sweep removes the bytes and marks the row expired.
 * The direct download (GET /orders/export) stays for small selections.
 */

const JOB = 'orders.export_file';
const KEEP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const TYPES = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function serialize(row) {
  return {
    id: row.id,
    kind: row.kind,
    format: row.format,
    status: row.status,
    fileName: row.fileName,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    expiresAt: row.expiresAt,
  };
}

/** POST /exports/orders: the same options as GET /orders/export, built in the background. */
async function startOrdersExport(workspaceId, userId, body, req) {
  const { lang, format, ...rest } = body;
  // A preset (accepted orders) fixes the columns and adds its filter, stored with the rest.
  const { preset, columns, rowPer, filters, fileName } = exportService.applyPreset(rest);
  const stamp = new Date().toISOString().slice(0, 10);
  const row = await db.sequelize.transaction(async (transaction) => {
    const created = await db.ExportFile.create(
      {
        workspaceId,
        userId,
        kind: 'orders',
        format,
        // Decided by who asks: the file is built later, without their session (SPEC §3.4 #8).
        params: { filters, columns: columns || null, rowPer, lang, maskPhones: !(req && req.tenant && req.tenant.hasPermission('customers.reveal_sensitive')), ...(preset ? { preset } : {}) },
        fileName: `${fileName}-${stamp}.${format}`,
      },
      { transaction }
    );
    await queue.add('io', JOB, { exportId: created.id }, { transaction, workspaceId, dedupeKey: `export:${created.id}` });
    return created;
  });
  await recordAudit({
    workspaceId,
    actorUserId: userId,
    action: 'order.export',
    entityType: 'Order',
    metadata: { filters, rowPer, format, columns: columns || 'default', background: true, exportId: row.id, ...(preset ? { preset } : {}) },
    req,
  });
  return serialize(row);
}

async function build(row) {
  const { filters, columns, rowPer, lang, maskPhones } = row.params || {};
  const workspace = await db.Workspace.findByPk(row.workspaceId, { attributes: ['timezone'] });
  // An export started before phones were masked has no flag: it is masked too.
  const options = { columns: columns || undefined, rowPer, lang, timezone: (workspace && workspace.timezone) || 'UTC', maskPhones: maskPhones !== false };
  if (row.format === 'xlsx') {
    const rows = await exportService.tableRows(row.workspaceId, filters || {}, options);
    return buildXlsx(rows, { sheetName: lang === 'ar' ? 'الأوردرات' : 'Orders', rtl: lang === 'ar' });
  }
  let csv = '';
  for await (const chunk of exportService.csvChunks(row.workspaceId, filters || {}, options)) csv += chunk;
  return Buffer.from(csv, 'utf8');
}

function tell(row, { failed }) {
  const notifications = require('../notifications/merchantNotificationService');
  return notifications.create(row.workspaceId, {
    type: 'export.ready',
    title: failed ? `تعذّر تجهيز الملف: ${row.fileName}` : `الملف جاهز: ${row.fileName}`,
    body: failed ? 'جرّب التصدير مرة أخرى، أو ضيّق الفلاتر.' : `الرابط متاح ${KEEP_DAYS} أيام.`,
    link: `/exports/${row.id}`,
    data: { name: row.fileName, exportId: row.id, ...(failed ? { failed: true } : {}) },
    userIds: [row.userId],
    dedupeKey: `export:${row.id}`,
  });
}

/** The `io` job: builds the file once (the queue does not retry io jobs) and tells the teammate. */
async function processExport(job) {
  const row = await db.ExportFile.findByPk(job.payload && job.payload.exportId);
  if (!row || row.status !== 'queued') return null;
  await row.update({ status: 'running' });
  try {
    const buffer = await build(row);
    const key = `exports/${row.workspaceId}/${row.id}.${row.format}`;
    await getStorage().putPrivate({ key, buffer, contentType: TYPES[row.format] });
    const now = new Date();
    await row.update({
      status: 'done',
      storagePath: key,
      contentType: TYPES[row.format],
      sizeBytes: buffer.length,
      completedAt: now,
      expiresAt: new Date(now.getTime() + KEEP_DAYS * DAY_MS),
    });
    await tell(row, { failed: false });
    return { exportId: row.id, sizeBytes: buffer.length };
  } catch (err) {
    logger.error('Order export failed', { workspaceId: row.workspaceId, exportId: row.id, message: err.message });
    await row.update({ status: 'failed', errorMessage: String(err.message).slice(0, 500), completedAt: new Date() });
    await tell(row, { failed: true });
    return { exportId: row.id, failed: true };
  }
}

async function findOwn(workspaceId, userId, exportId) {
  const row = await db.ExportFile.findOne({ where: { id: exportId, workspaceId, userId } });
  if (!row) throw new NotFoundError('Export');
  return row;
}

async function getExport(workspaceId, userId, exportId) {
  return serialize(await findOwn(workspaceId, userId, exportId));
}

/** The file's bytes for its owner, while it is kept. */
async function readExport(workspaceId, userId, exportId) {
  const row = await findOwn(workspaceId, userId, exportId);
  if (row.status === 'expired' || (row.expiresAt && row.expiresAt < new Date())) {
    throw new AppError('EXPORT_EXPIRED', 'This file is no longer kept — export again', 410);
  }
  if (row.status !== 'done') throw new AppError('EXPORT_NOT_READY', 'This file is not ready yet', 409);
  const object = await getStorage().getPrivate(row.storagePath);
  if (!object) throw new AppError('EXPORT_EXPIRED', 'This file is no longer kept — export again', 410);
  return { buffer: object.buffer, contentType: row.contentType || TYPES[row.format], fileName: row.fileName };
}

/** Removes the files past their keep date (and any stuck in `running` for a day: a crashed worker). */
async function sweep() {
  const now = new Date();
  const { Op } = db.Sequelize;
  const expired = await db.ExportFile.findAll({ where: { status: 'done', expiresAt: { [Op.lt]: now } }, limit: 500 });
  for (const row of expired) {
    try {
      if (row.storagePath) await getStorage().removePrivate(row.storagePath);
      await row.update({ status: 'expired', storagePath: null });
    } catch (err) {
      logger.warn('Could not remove an expired export', { exportId: row.id, message: err.message });
    }
  }
  const [stuck] = await db.ExportFile.update(
    { status: 'failed', errorMessage: 'Interrupted', completedAt: now },
    { where: { status: 'running', updatedAt: { [Op.lt]: new Date(now.getTime() - DAY_MS) } } }
  );
  return { expired: expired.length, interrupted: stuck };
}

module.exports = { JOB, startOrdersExport, processExport, getExport, readExport, sweep, KEEP_DAYS };
