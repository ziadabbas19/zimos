'use strict';

// The product import's job (catalog/importExport/productTransfer.js): the
// report it writes, its progress while it runs, and the ending an import gets
// when its worker stops mid-run — before, it stayed "running" for good and
// the dashboard waited for it forever.

const { registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const transfer = require('../../src/modules/catalog/importExport/productTransfer');
const catalogJobs = require('../../src/modules/catalog/jobs');

const good = (name, row) => ({ __row: row, name, status: 'draft', variants: [{ priceAmount: 2500, stockOnHand: 0 }] });
const noPrice = (name, row) => ({ __row: row, name, variants: [{ priceAmount: null }] });

async function importRow(fields) {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken);
  const row = await db.CatalogImport.create({ workspaceId: workspace.id, kind: 'json', createdBy: auth.userId, ...fields });
  return { row, workspace };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('runImport', () => {
  it('creates the products it can and reports each one it cannot, by row', async () => {
    const payload = [good('Mug', 1), noPrice('Broken', 2), good('Cup', 3)];
    const { row, workspace } = await importRow({ payload, total: payload.length });

    await transfer.runImport(row.id);

    const done = await db.CatalogImport.findByPk(row.id);
    expect(done.status).toBe('done');
    expect(done.createdCount).toBe(2);
    expect(done.failedCount).toBe(1);
    expect(done.errors).toEqual([{ row: 2, name: 'Broken', message: expect.stringContaining('price') }]);
    expect(done.payload).toEqual([]);
    expect(done.finishedAt).not.toBeNull();
    expect(await db.Product.count({ where: { workspaceId: workspace.id } })).toBe(2);
  });

  it('writes its counts while it runs, so the dashboard can show them', async () => {
    const payload = [good('One', 1), noPrice('Two', 2), good('Three', 3)];
    const { row } = await importRow({ payload, total: payload.length });
    // Every product looks two seconds after the last one: a progress write each time.
    let clock = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => (clock += 2500));
    const update = jest.spyOn(db.CatalogImport, 'update');

    await transfer.runImport(row.id);

    const writes = update.mock.calls.map(([fields]) => fields).filter((fields) => fields.status === undefined);
    expect(writes.map((fields) => [fields.createdCount, fields.failedCount])).toEqual([
      [1, 0],
      [1, 1],
      [2, 1],
    ]);
    expect((await db.CatalogImport.findByPk(row.id)).status).toBe('done');
  });

  it('runs once: an import that is not queued any more is left as it is', async () => {
    const { row, workspace } = await importRow({ payload: [good('Mug', 1)], total: 1, status: 'failed' });
    await transfer.runImport(row.id);
    expect((await db.CatalogImport.findByPk(row.id)).status).toBe('failed');
    expect(await db.Product.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });
});

describe('importInterrupted (its worker stopped mid-run)', () => {
  it('closes a running import as failed with the counts it last wrote and says why', async () => {
    const known = { row: 4, name: 'Broken', message: 'Variant 1: the price is missing or not a number' };
    const { row } = await importRow({ status: 'running', total: 24, createdCount: 10, failedCount: 1, errors: [known], payload: [good('Left', 1)] });

    await transfer.importInterrupted({ queue: 'io', name: 'catalog.import', payload: { importId: row.id } });

    const closed = await db.CatalogImport.findByPk(row.id);
    expect(closed.status).toBe('failed');
    expect(closed.createdCount).toBe(10);
    expect(closed.failedCount).toBe(14);
    expect(closed.errors[0]).toEqual(known);
    expect(closed.errors[1]).toEqual({ row: null, name: '', message: expect.stringContaining('server restarted') });
    expect(closed.payload).toEqual([]);
    expect(closed.finishedAt).not.toBeNull();
  });

  it('leaves a finished import alone, and ignores a job without an import', async () => {
    const { row } = await importRow({ status: 'done', total: 2, createdCount: 2 });
    await transfer.importInterrupted({ payload: { importId: row.id } });
    await transfer.importInterrupted({ payload: {} });
    const after = await db.CatalogImport.findByPk(row.id);
    expect(after.status).toBe('done');
    expect(after.errors).toEqual([]);
  });

  it('is the catalog.import job’s interruption hook', () => {
    const processor = catalogJobs.processors.find((p) => p.queue === 'io' && p.name === 'catalog.import');
    expect(typeof processor.onInterrupted).toBe('function');
  });
});
