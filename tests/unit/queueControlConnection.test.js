'use strict';

// The driver with both its connections stubbed out: this file loads no models
// and opens no connection.
const mockShared = { query: jest.fn(), config: { database: 'db', username: 'u', password: 'p', host: 'h', port: 5432, dialectOptions: { ssl: false } } };
const mockControl = { query: jest.fn(), close: jest.fn().mockResolvedValue() };
const mockOpened = [];

jest.mock('../../src/db/models', () => ({ sequelize: mockShared }));
jest.mock('sequelize', () => {
  const actual = jest.requireActual('sequelize');
  return {
    ...actual,
    Sequelize: jest.fn((...args) => {
      mockOpened.push(args);
      return mockControl;
    }),
  };
});

const { ConnectionError } = require('sequelize');
const driver = require('../../src/core/queue/postgresDriver');

const isClaim = (sql) => /SET status = 'active'/.test(sql);
const isSweep = (sql) => /WITH stale AS/.test(sql);
const isHeartbeat = (sql) => /^UPDATE queue_jobs SET locked_at = NOW\(\)/.test(sql);
const isCompletion = (sql) => /SET status = 'completed'/.test(sql);
const statements = (connection, test) => connection.query.mock.calls.filter(([sql]) => test(sql));
const waitFor = async (check) => {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
};

// A job is handed out once, then the queue is empty.
function answering(job) {
  let given = false;
  return async (sql) => {
    if (isClaim(sql)) {
      if (given || !job) return [];
      given = true;
      return [job];
    }
    if (isSweep(sql)) return [];
    return [[], { rowCount: 1 }];
  };
}

const JOB = { id: 'job-1', queue: 'io', name: 'test.job', payload: {}, attempts: 1, maxAttempts: 3, workspaceId: null };

// The queue's control plane (core/queue/postgresDriver): claiming, renewing
// locks and the stale sweep, on a connection the jobs cannot use up.
describe('queue control connection', () => {
  beforeEach(() => {
    mockShared.query.mockReset();
    mockControl.query.mockReset();
    mockControl.close.mockClear();
    mockOpened.length = 0;
    driver.process('io', async () => {});
  });
  afterEach(async () => {
    await driver.stop();
  });

  it('off: every statement uses the shared pool and nothing else is opened', async () => {
    mockShared.query.mockImplementation(answering(JOB));
    await driver.start({ pollMs: 250, staleLockMs: 10000 });
    await waitFor(() => statements(mockShared, isCompletion).length === 1);
    await driver.releaseStale({ force: true });
    expect(mockOpened).toHaveLength(0);
    expect(statements(mockShared, isClaim).length).toBeGreaterThan(0);
    expect(statements(mockShared, isSweep).length).toBeGreaterThan(0);
    expect(mockControl.query).not.toHaveBeenCalled();
  });

  it('on: claims, the sweep and heartbeats use their own connection; the outcome uses the shared pool', async () => {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    driver.process('io', () => held);
    mockControl.query.mockImplementation(answering(JOB));
    mockShared.query.mockImplementation(answering(null));
    // The shortest lock the driver takes gives a heartbeat every second.
    await driver.start({ pollMs: 250, staleLockMs: 4000, controlConnection: true });
    await waitFor(() => statements(mockControl, isHeartbeat).length >= 1);
    await driver.releaseStale({ force: true });
    release();
    await waitFor(() => statements(mockShared, isCompletion).length === 1);

    // Opened with the main connection's own settings, and a pool of its own.
    expect(mockOpened).toHaveLength(1);
    expect(mockOpened[0].slice(0, 3)).toEqual(['db', 'u', 'p']);
    expect(mockOpened[0][3]).toMatchObject({ host: 'h', port: 5432, dialect: 'postgres', dialectOptions: { ssl: false }, pool: { max: 2, min: 1 } });

    expect(statements(mockControl, isClaim).length).toBeGreaterThan(0);
    expect(statements(mockControl, isSweep).length).toBeGreaterThan(0);
    expect(statements(mockShared, isClaim)).toHaveLength(0);
    expect(statements(mockShared, isSweep)).toHaveLength(0);
    expect(statements(mockShared, isHeartbeat)).toHaveLength(0);
    expect(statements(mockControl, isCompletion)).toHaveLength(0);

    await driver.stop();
    expect(mockControl.close).toHaveBeenCalledTimes(1);
  }, 15000);

  it('on, with no connection to be had: the statement runs on the shared pool instead', async () => {
    mockControl.query.mockRejectedValue(new ConnectionError(new Error('too many clients')));
    mockShared.query.mockImplementation(answering(JOB));
    await driver.start({ pollMs: 250, staleLockMs: 10000, controlConnection: true });
    await waitFor(() => statements(mockShared, isCompletion).length === 1);
    expect(statements(mockControl, isClaim).length).toBeGreaterThan(0);
    expect(statements(mockShared, isClaim).length).toBeGreaterThan(0);
  });

  it('on: a statement the database refused is not run a second time', async () => {
    mockControl.query.mockRejectedValue(new Error('deadlock detected'));
    mockShared.query.mockImplementation(answering(JOB));
    await driver.start({ pollMs: 250, staleLockMs: 10000, controlConnection: true });
    await waitFor(() => mockControl.query.mock.calls.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(statements(mockShared, isClaim)).toHaveLength(0);
    expect(statements(mockShared, isSweep)).toHaveLength(0);
  });
});
