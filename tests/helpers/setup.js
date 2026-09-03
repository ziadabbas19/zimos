'use strict';

const { truncateAll } = require('./db');
const db = require('../../src/db/models');

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.sequelize.close();
});
