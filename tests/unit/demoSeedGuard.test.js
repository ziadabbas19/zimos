'use strict';

const { assertDemoSeedAllowed } = require('../../src/db/seedGuards');
const demoSeeder = require('../../src/db/seeders/20260101000000-demo-data');

// The demo seeder (db/seedGuards): its owner account has a public password and
// its undo empties whole tables, so a production database is out of bounds.
describe('demo seeder guard', () => {
  it('allows development and test, and anything but production', () => {
    expect(() => assertDemoSeedAllowed('up', { NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertDemoSeedAllowed('up', { NODE_ENV: 'test' })).not.toThrow();
    expect(() => assertDemoSeedAllowed('down', {})).not.toThrow();
  });

  it('refuses both directions under NODE_ENV=production', () => {
    expect(() => assertDemoSeedAllowed('up', { NODE_ENV: 'production' })).toThrow(/Refusing to run the demo seeder \(up\)/);
    expect(() => assertDemoSeedAllowed('down', { NODE_ENV: 'production' })).toThrow(/Refusing to run the demo seeder \(down\)/);
  });

  it('takes the override only when it is exactly "true"', () => {
    expect(() => assertDemoSeedAllowed('up', { NODE_ENV: 'production', ALLOW_DEMO_SEED_IN_PRODUCTION: 'true' })).not.toThrow();
    for (const value of ['1', 'TRUE', 'yes', '', ' true']) {
      expect(() => assertDemoSeedAllowed('up', { NODE_ENV: 'production', ALLOW_DEMO_SEED_IN_PRODUCTION: value })).toThrow(/Refusing/);
    }
  });

  describe('the seeder itself', () => {
    const saved = { NODE_ENV: process.env.NODE_ENV, ALLOW: process.env.ALLOW_DEMO_SEED_IN_PRODUCTION };
    afterEach(() => {
      process.env.NODE_ENV = saved.NODE_ENV;
      if (saved.ALLOW === undefined) delete process.env.ALLOW_DEMO_SEED_IN_PRODUCTION;
      else process.env.ALLOW_DEMO_SEED_IN_PRODUCTION = saved.ALLOW;
    });

    it('writes and deletes nothing in production', async () => {
      const queryInterface = { bulkInsert: jest.fn(), bulkDelete: jest.fn() };
      process.env.NODE_ENV = 'production';
      delete process.env.ALLOW_DEMO_SEED_IN_PRODUCTION;
      await expect(demoSeeder.up(queryInterface, {})).rejects.toThrow(/Refusing to run the demo seeder/);
      await expect(demoSeeder.down(queryInterface)).rejects.toThrow(/Refusing to run the demo seeder/);
      expect(queryInterface.bulkInsert).not.toHaveBeenCalled();
      expect(queryInterface.bulkDelete).not.toHaveBeenCalled();
    });
  });
});
