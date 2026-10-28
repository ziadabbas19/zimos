'use strict';

const { createIndexConcurrently, dropIndexConcurrently } = require('../concurrentIndex');
const { withShortLock } = require('../shortLock');

/**
 * Accepting an invite (workspaces/inviteAcceptance.js): the link in the
 * invite email carries a random token, and a pending membership (status
 * 'invited', keyed on invited_email) is turned into an active one by the
 * account that opens it with the same email address.
 *
 * memberships.invite_token_hash   SHA-256 of the token (core/security/tokens
 *                                 hashToken); the raw token is only in the
 *                                 email. A resend replaces it. Kept after the
 *                                 invite is accepted, so an old link says
 *                                 "already accepted" instead of "unknown".
 * memberships.invite_expires_at   when the link stops working.
 * memberships.invite_accepted_at  when it was accepted (null until then).
 *
 * memberships_invite_token_hash_uq (UNIQUE, partial, CONCURRENTLY) finds an
 * invite by its token.
 *
 * Invites sent before this migration have no token: their link opens the
 * page, which asks for a new invite (the store resends it). No data is
 * written. Run-twice safe (IF NOT EXISTS, and the index helper looks first).
 * Down drops the index and the three columns; a membership accepted through
 * a token stays active.
 */

const INDEX = 'memberships_invite_token_hash_uq';

module.exports = {
  up: async (queryInterface) => {
    await withShortLock(queryInterface, [
      'ALTER TABLE memberships ADD COLUMN IF NOT EXISTS invite_token_hash VARCHAR(64)',
      'ALTER TABLE memberships ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMPTZ',
      'ALTER TABLE memberships ADD COLUMN IF NOT EXISTS invite_accepted_at TIMESTAMPTZ',
    ]);
    await createIndexConcurrently(queryInterface, {
      name: INDEX,
      table: 'memberships',
      definition: '(invite_token_hash) WHERE invite_token_hash IS NOT NULL',
      unique: true,
    });
  },

  down: async (queryInterface) => {
    await dropIndexConcurrently(queryInterface, INDEX);
    await withShortLock(queryInterface, [
      'ALTER TABLE memberships DROP COLUMN IF EXISTS invite_accepted_at',
      'ALTER TABLE memberships DROP COLUMN IF EXISTS invite_expires_at',
      'ALTER TABLE memberships DROP COLUMN IF EXISTS invite_token_hash',
    ]);
  },
};
