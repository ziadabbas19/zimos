'use strict';

const crypto = require('crypto');
const { Router } = require('express');
const Joi = require('joi');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { authLimiter, authIpLimiter } = require('../../core/middleware/rateLimiters');
const { requirePlatformPermission } = require('../../core/middleware/platformAdminGuard');
const { PLATFORM_PERMISSIONS } = require('../../core/security/platformPermissions');
const { verifyPassword } = require('../../core/security/password');
const { AppError, ValidationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const notify = require('../notifications/notify');

/**
 * Getting back into an account whose second step is out of reach.
 *
 *   Backup codes   ten one-time codes, made by the person (password asked)
 *                  and shown once. Any of them finishes a sign-in in place
 *                  of the email, WhatsApp or authenticator code. Using one
 *                  emails the person. Making new ones voids the old.
 *   Platform reset with no code left, the person asks support. A platform
 *                  user holding support.manage turns the second step off
 *                  after checking who they are. That ends every session,
 *                  forgets remembered browsers, and emails the person.
 *   Password reset (authService) does not turn the second step off: a
 *                  mailbox that can reset the password must not also get
 *                  past an authenticator. It forgets remembered browsers
 *                  instead, so every device asks for the second step again.
 *
 *   POST /auth/two-factor/backup-codes            { password } → { codes, createdAt }
 *   POST /admin/users/:userId/two-factor/reset    → { mode: 'off' }
 */

const CODE_COUNT = 10;
// No 0/O or 1/I/L: the codes are read off paper.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const normalise = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashOf = (userId, code) => sha256(`backup:${userId}:${normalise(code)}`);

function newCode() {
  let out = '';
  for (let i = 0; i < 8; i += 1) out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** What the security screen shows about the codes. */
function backupStatus(row) {
  const codes = row && Array.isArray(row.backupCodes) ? row.backupCodes : [];
  return { backupCodesLeft: codes.filter((c) => !c.usedAt).length, backupCodesCreatedAt: row ? row.backupCodesCreatedAt : null };
}

function securityEmail(user, kind, extra = {}) {
  return notify
    .email({ recipient: user.email, template: 'security_notice', data: { ...extra, kind, locale: extra.locale === 'en' ? 'en' : 'ar' } })
    .catch(() => {});
}

async function createBackupCodes(user, { password }, req) {
  if (user.passwordHash && !(password && (await verifyPassword(password, user.passwordHash)))) {
    // 422, not 401: the dashboard treats a 401 as a dead session.
    throw new ValidationError([{ field: 'password', message: 'The password is not correct' }]);
  }
  const row = await db.UserTwoFactor.findByPk(user.id);
  if (!row || row.mode === 'off') throw new AppError('TWO_FACTOR_OFF', 'Turn on two-step sign-in first', 409);
  const codes = Array.from({ length: CODE_COUNT }, newCode);
  const createdAt = new Date();
  await row.update({ backupCodes: codes.map((code) => ({ hash: hashOf(user.id, code), usedAt: null })), backupCodesCreatedAt: createdAt });
  await recordAudit({ actorUserId: user.id, action: 'user.two_factor_backup_codes', entityType: 'User', entityId: user.id, after: { count: CODE_COUNT }, req });
  return { codes, createdAt };
}

/**
 * Spends a backup code for this person, if `code` is one of theirs and
 * unused. Called by twoFactorService.verifyChallenge when the code is not
 * the challenge's own.
 */
async function useBackupCode(user, code, req) {
  if (normalise(code).length !== 8) return false;
  return db.sequelize.transaction(async (transaction) => {
    const row = await db.UserTwoFactor.findByPk(user.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!row || !Array.isArray(row.backupCodes)) return false;
    const given = Buffer.from(hashOf(user.id, code));
    const index = row.backupCodes.findIndex((c) => !c.usedAt && c.hash && crypto.timingSafeEqual(Buffer.from(c.hash), given));
    if (index < 0) return false;
    const next = row.backupCodes.map((c, i) => (i === index ? { ...c, usedAt: new Date().toISOString() } : c));
    await row.update({ backupCodes: next }, { transaction });
    const left = next.filter((c) => !c.usedAt).length;
    await recordAudit({ actorUserId: user.id, action: 'user.two_factor_backup_code_used', entityType: 'User', entityId: user.id, after: { left }, req, transaction });
    transaction.afterCommit(() => securityEmail(user, 'backup_code_used', { left }));
    return true;
  });
}

/**
 * The platform's reset, for a person who lost every way through the second step.
 * Who may be reset follows the console's other account actions
 * (platformAdmin/userModerationService.lockTarget): never your own account, a
 * creator's only by a creator, another console account only with admins.manage.
 */
async function adminReset(userId, req) {
  const { lockTarget } = require('../platformAdmin/userModerationService');
  const { user, before } = await db.sequelize.transaction(async (transaction) => {
    const target = await lockTarget(userId, req, transaction, { permission: PLATFORM_PERMISSIONS.SUPPORT_MANAGE });
    const row = await db.UserTwoFactor.findByPk(target.id, { transaction, lock: transaction.LOCK.UPDATE });
    const previous = row ? row.mode : 'off';
    if (row) {
      await row.update({ mode: 'off', totpSecretSealed: null, pendingSecretSealed: null, enabledAt: null, backupCodes: [], backupCodesCreatedAt: null }, { transaction });
    }
    await db.TrustedDevice.destroy({ where: { userId: target.id }, transaction });
    await db.Session.update({ revokedAt: new Date() }, { where: { userId: target.id, revokedAt: null }, transaction });
    await recordAudit({
      actorUserId: req.user.id,
      action: 'admin.user_two_factor_reset',
      entityType: 'User',
      entityId: target.id,
      before: { mode: previous },
      after: { mode: 'off' },
      req,
      transaction,
    });
    return { user: target, before: previous };
  });
  await securityEmail(user, 'two_factor_reset');
  return { mode: 'off', previousMode: before };
}

// ------------------------------------------------------------------ routes --

const router = Router();
router.post(
  '/two-factor/backup-codes',
  authIpLimiter,
  authLimiter,
  authenticate,
  validate({ body: Joi.object({ password: Joi.string().max(200).allow('', null).optional() }) }),
  asyncHandler(async (req, res) => res.status(201).json(await createBackupCodes(req.user, req.body, req)))
);

const adminRouter = Router();
adminRouter.post(
  '/users/:userId/two-factor/reset',
  requirePlatformPermission(PLATFORM_PERMISSIONS.SUPPORT_MANAGE),
  validate({ params: Joi.object({ userId: Joi.string().uuid().required() }) }),
  asyncHandler(async (req, res) => res.json(await adminReset(req.params.userId, req)))
);

module.exports = { router, adminRouter, backupStatus, createBackupCodes, useBackupCode, adminReset, normalise };
