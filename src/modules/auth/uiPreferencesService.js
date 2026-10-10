'use strict';

const db = require('../../db/models');
const { stamp, present } = require('./uiPreferences');

/**
 * users.ui_preferences (migration 701) for the signed-in account. Both
 * functions are given req.user's id and no route takes another account's, so
 * no account can read or change another's.
 *
 * Raw SQL: the column is not on the User model, so signing in, the session
 * check and every other read of a user go on exactly as they did. A save
 * leaves users.updated_at alone and is not audited: it is how a screen looks,
 * and the dashboard saves it as a slider comes to rest.
 */

/** GET /auth/me/ui-preferences — null until the account saves something. */
async function read(userId) {
  const [row] = await db.sequelize.query('SELECT ui_preferences FROM users WHERE id = :userId', {
    replacements: { userId },
    type: db.Sequelize.QueryTypes.SELECT,
  });
  return present(row ? row.ui_preferences : null);
}

/**
 * PATCH /auth/me/ui-preferences — replaces the appearance part, whole, and
 * leaves any other part of the value as it is. One statement: two saves at
 * once end as one of them, never a mix.
 */
async function saveAppearance(userId, values) {
  const [row] = await db.sequelize.query(
    `UPDATE users
        SET ui_preferences = COALESCE(ui_preferences, CAST('{}' AS jsonb)) || jsonb_build_object('appearance', CAST(:appearance AS jsonb))
      WHERE id = :userId
      RETURNING ui_preferences`,
    { replacements: { userId, appearance: JSON.stringify(stamp(values)) }, type: db.Sequelize.QueryTypes.SELECT }
  );
  return present(row ? row.ui_preferences : null);
}

module.exports = { read, saveAppearance };
