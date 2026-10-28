'use strict';

const db = require('../../db/models');
const { generateOpaqueToken, hashToken } = require('../../core/security/tokens');
const { AppError, ConflictError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/**
 * Accepting an invite sent to someone who had no account yet.
 *
 * inviteMember (workspaceService) adds an existing, confirmed account at once;
 * for any other address it keeps a pending membership (status 'invited',
 * invited_email) and emails a link with a random token. Only the token's
 * SHA-256 is stored (memberships.invite_token_hash, migration 725), the link
 * works for INVITE_TTL_DAYS and once, and a resend replaces the token.
 *
 * The invitee opens the link, signs in or signs up (Google included) with
 * the invited address, and POST /invites/:token/accept turns the pending row
 * into their membership — with the role it was created with, never one the
 * request names. Holding the link proves the inbox; the address must still be
 * the account's own (compared trimmed and lower-cased: users.email is citext,
 * invited_email plain text).
 */

const INVITE_TTL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

/** A where clause matching memberships.invited_email to `email`, whatever its case. */
function invitedEmailIs(email) {
  return db.sequelize.where(db.sequelize.fn('lower', db.sequelize.col('invited_email')), normalizeEmail(email));
}

/** A new link for a pending invite: the raw token (for the email only) and the columns to store. */
function newInviteToken(now = new Date()) {
  const token = generateOpaqueToken(32);
  return {
    token,
    fields: {
      inviteTokenHash: hashToken(token),
      inviteExpiresAt: new Date(now.getTime() + INVITE_TTL_DAYS * DAY_MS),
      inviteAcceptedAt: null,
    },
  };
}

/** pending | expired | accepted | invalid (no such invite). */
function inviteState(membership, now = new Date()) {
  if (!membership) return 'invalid';
  if (membership.inviteAcceptedAt || membership.status !== 'invited') return 'accepted';
  if (!membership.inviteExpiresAt || new Date(membership.inviteExpiresAt) <= now) return 'expired';
  return 'pending';
}

function findByToken(token, options = {}) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return Promise.resolve(null);
  return db.Membership.findOne({ where: { inviteTokenHash: hashToken(token) }, ...options });
}

const invalidLink = () =>
  new AppError('INVITE_INVALID', 'This invite link is not valid. Ask the store to send you a new invite.', 404);

/** GET /invites/:token — what the invite page shows, before anyone signs in. */
async function describeInvite(token) {
  const membership = await findByToken(token, {
    include: [
      { model: db.Workspace, as: 'workspace', attributes: ['id', 'name'] },
      { model: db.Role, as: 'role', attributes: ['id', 'key', 'name'] },
    ],
  });
  const state = inviteState(membership);
  if (state === 'invalid') throw invalidLink();
  return {
    state,
    workspace: { name: membership.workspace.name },
    role: { key: membership.role.key, name: membership.role.name },
    // The address to sign in or sign up with; gone once the invite is accepted.
    email: state === 'accepted' ? null : membership.invitedEmail,
    expiresAt: membership.inviteExpiresAt,
  };
}

/** POST /invites/:token/accept — the signed-in `user` joins with the invite's role. */
async function acceptInvite(token, user, req) {
  const membership = await db.sequelize.transaction(async (transaction) => {
    // Locked alone (FOR UPDATE refuses the outer joins of an include): two
    // tabs accepting the same link wait for each other, and the second is told
    // it was already accepted.
    const invite = await findByToken(token, { transaction, lock: transaction.LOCK.UPDATE });
    const state = inviteState(invite);
    if (state === 'invalid') throw invalidLink();
    if (state === 'accepted') {
      throw new AppError('INVITE_ALREADY_ACCEPTED', 'This invite has already been accepted.', 409);
    }
    if (state === 'expired') {
      throw new AppError('INVITE_EXPIRED', 'This invite has expired. Ask the store to send it again.', 410);
    }
    if (normalizeEmail(user.email) !== normalizeEmail(invite.invitedEmail)) {
      throw new AppError(
        'INVITE_EMAIL_MISMATCH',
        'This invite was sent to another email address. Sign in with that address to accept it.',
        403
      );
    }
    const existing = await db.Membership.findOne({
      where: { workspaceId: invite.workspaceId, userId: user.id },
      attributes: ['id'],
      transaction,
    });
    if (existing) throw new ConflictError('You are already a member of this store', 'ALREADY_MEMBER');

    // The role stays the one the inviter was allowed to give (assertCanGrant
    // at invite time); nothing from this request reaches it.
    await invite.update(
      { userId: user.id, status: 'active', invitedEmail: null, inviteAcceptedAt: new Date() },
      { transaction }
    );
    return invite;
  });

  const [workspace, role] = await Promise.all([
    db.Workspace.findByPk(membership.workspaceId, { attributes: ['id', 'name', 'slug'] }),
    db.Role.findByPk(membership.roleId, { attributes: ['id', 'key', 'name'] }),
  ]);

  await recordAudit({
    workspaceId: membership.workspaceId,
    actorUserId: user.id,
    action: 'membership.invite_accept',
    entityType: 'Membership',
    entityId: membership.id,
    after: { roleId: membership.roleId },
    req,
  });

  return {
    workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
    role: { key: role.key, name: role.name },
  };
}

module.exports = {
  INVITE_TTL_DAYS,
  normalizeEmail,
  invitedEmailIs,
  newInviteToken,
  inviteState,
  describeInvite,
  acceptInvite,
};
