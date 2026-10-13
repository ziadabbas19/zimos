'use strict';

// The driver with its connection stubbed out: this file loads no models.
const mockShared = { query: jest.fn() };
jest.mock('../../src/db/models', () => ({ sequelize: mockShared }));

const driver = require('../../src/core/queue/postgresDriver');

const isClaim = (sql) => /SET status = 'active'/.test(sql);
const isSweep = (sql) => /WITH stale AS/.test(sql);
const sent = (test) => mockShared.query.mock.calls.filter(([sql]) => test(sql));
const waitFor = async (check) => {
  for (let i = 0; i < 300 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
};

function handOut(job) {
  let given = false;
  mockShared.query.mockImplementation(async (sql) => {
    if (isClaim(sql)) {
      if (given) return [];
      given = true;
      return [job];
    }
    if (isSweep(sql)) return [];
    return [[], { rowCount: 1 }];
  });
}

const job = (fields) => ({ id: 'job-1', queue: 'io', name: 'test.job', payload: {}, attempts: 2, maxAttempts: 3, workspaceId: null, ...fields });

// What a run may write about its job (core/queue/postgresDriver): only while
// the row is still on the attempt this run was handed. A run whose job was
// taken back and claimed again by the same process holds an older number.
describe('a job outcome is recorded by the attempt that ran', () => {
  beforeEach(() => mockShared.query.mockReset());
  afterEach(async () => {
    await driver.stop();
  });

  const FENCED = /WHERE id = :id AND locked_by = :worker AND status = 'active' AND attempts = :attempts$/;

  it('a finished run completes its own attempt only', async () => {
    handOut(job({ attempts: 2 }));
    driver.process('io', async () => {});
    await driver.start({ pollMs: 250, staleLockMs: 10000 });
    await waitFor(() => sent((sql) => /SET status = 'completed'/.test(sql)).length === 1);
    const [sql, options] = sent((s) => /SET status = 'completed'/.test(s))[0];
    expect(sql).toMatch(FENCED);
    expect(options.replacements).toMatchObject({ id: 'job-1', attempts: 2 });
  });

  it('a failed run puts back in line its own attempt only', async () => {
    handOut(job({ attempts: 1 }));
    driver.process('io', async () => {
      throw new Error('boom');
    });
    await driver.start({ pollMs: 250, staleLockMs: 10000 });
    await waitFor(() => sent((sql) => /SET status = 'pending', run_at/.test(sql)).length === 1);
    const [sql, options] = sent((s) => /SET status = 'pending', run_at/.test(s))[0];
    expect(sql).toMatch(FENCED);
    expect(options.replacements).toMatchObject({ id: 'job-1', attempts: 1 });
  });

  it('a run out of attempts fails its own attempt only', async () => {
    handOut(job({ attempts: 3, maxAttempts: 3 }));
    driver.process('io', async () => {
      throw new Error('boom');
    });
    await driver.start({ pollMs: 250, staleLockMs: 10000 });
    await waitFor(() => sent((sql) => /SET status = 'failed'/.test(sql)).length === 1);
    const [sql, options] = sent((s) => /SET status = 'failed'/.test(s))[0];
    expect(sql).toMatch(FENCED);
    expect(options.replacements).toMatchObject({ id: 'job-1', attempts: 3 });
  });

  it('a heartbeat renews the lock of its own attempt only', async () => {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    handOut(job({ attempts: 2 }));
    driver.process('io', () => held);
    // The shortest lock the driver takes gives a heartbeat every second.
    await driver.start({ pollMs: 250, staleLockMs: 4000 });
    await waitFor(() => sent((sql) => /^UPDATE queue_jobs SET locked_at = NOW\(\)/.test(sql)).length >= 1);
    const [sql, options] = sent((s) => /^UPDATE queue_jobs SET locked_at = NOW\(\)/.test(s))[0];
    expect(sql).toMatch(FENCED);
    expect(options.replacements).toMatchObject({ id: 'job-1', attempts: 2 });
    release();
    await waitFor(() => sent((s) => /SET status = 'completed'/.test(s)).length === 1);
  }, 15000);
});
