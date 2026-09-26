'use strict';

const { truncateAll } = require('./db');
const networkGuard = require('./networkGuard');
const db = require('../../src/db/models');

networkGuard.install();

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  const blocked = networkGuard.takeBlocked();
  if (blocked.length > 0) {
    throw new Error(`This test tried to reach the network:\n  ${blocked.join('\n  ')}`);
  }
});

afterAll(async () => {
  await db.sequelize.close();
});
