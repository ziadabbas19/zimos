'use strict';

/**
 * Grants the global platform-admin flag (users.platform_admin) to one account.
 *
 *   node scripts/grant-platform-admin.js ziadabbas27@gmail.com
 *
 * That flag is what `requirePlatformAdmin` checks, and it is the only gate on
 * /api/v1/admin/* — it bypasses workspace RBAC entirely and exposes every
 * workspace on the instance. There is deliberately no API endpoint that sets
 * it: the first platform admin has to be made out-of-band, here.
 *
 * Runs against whatever database src/config/env resolves (DATABASE_URL, else
 * the DB_* vars in .env), so check which one that is before running it in an
 * environment that matters. Re-running for the same account is a no-op.
 */

const db = require('../src/db/models');

async function main() {
  const email = (process.argv[2] || '').trim();
  if (!email) {
    console.error('Usage: node scripts/grant-platform-admin.js <email>');
    process.exitCode = 1;
    return;
  }

  // Emails are stored exactly as registered — no normalization anywhere in
  // authService — so this matches the same way login does.
  const user = await db.User.findOne({ where: { email } });
  if (!user) {
    console.error(`No account with email "${email}".`);
    const known = await db.User.findAll({
      attributes: ['email'],
      order: [['createdAt', 'ASC']],
      raw: true,
    });
    if (known.length) {
      console.error(`Known accounts:\n${known.map((u) => `  ${u.email}`).join('\n')}`);
    }
    process.exitCode = 1;
    return;
  }

  if (user.platformAdmin) {
    console.log(`${user.email} is already a platform admin — nothing to do.`);
    return;
  }

  await user.update({ platformAdmin: true });
  console.log(`${user.email} is now a platform admin.`);

  // `authenticate` rejects anything that is not active, so the flag alone is
  // not enough to actually reach /admin/*.
  if (user.status !== 'active') {
    console.log(`Warning: status is "${user.status}" — it must be "active" to authenticate.`);
  }

  console.log('Sign out and back in: the platformAdmin flag is read from the login response.');
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => db.sequelize.close());
