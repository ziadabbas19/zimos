'use strict';

/**
 * The demo seeder (seeders/20260101000000-demo-data.js) creates an active,
 * verified workspace owner whose email and password are printed in this
 * repository, and its `down` empties whole tables rather than its own rows.
 * Both are for a developer's own database: under NODE_ENV=production the
 * seeder refuses to run, in either direction, unless
 * ALLOW_DEMO_SEED_IN_PRODUCTION is exactly "true".
 *
 * Read from process.env, not config/env.js: sequelize-cli runs seeders outside
 * the app's boot path (config/sequelize-cli.js does the same).
 */
function assertDemoSeedAllowed(direction, environment = process.env) {
  if (environment.NODE_ENV !== 'production') return;
  if (environment.ALLOW_DEMO_SEED_IN_PRODUCTION === 'true') return;
  throw new Error(
    `Refusing to run the demo seeder (${direction}) under NODE_ENV=production: it ` +
      (direction === 'down'
        ? 'deletes every row of the tables it seeded, not only its own.'
        : 'creates an owner account whose password is public.') +
      ' To load only the plans and templates, run those seeders by name (README, "Running locally").' +
      ' On a throwaway database, set ALLOW_DEMO_SEED_IN_PRODUCTION=true for this one command.'
  );
}

module.exports = { assertDemoSeedAllowed };
