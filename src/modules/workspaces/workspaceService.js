'use strict';

const crypto = require('crypto');
const {
  toWorkspaceSlug,
  suffixSlug,
  slugRejectionReason,
  normalizeSlug,
  REASON_MESSAGES,
} = require('../../core/utils/workspaceSlug');
const db = require('../../db/models');
const { SYSTEM_ROLES, PERMISSIONS } = require('../../core/security/permissions');
const {
  ConflictError,
  NotFoundError,
  AppError,
  ValidationError,
  AuthorizationError,
} = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const notify = require('../notifications/notify');
const billingService = require('../billing/billingService');

async function sendInviteEmail(workspace, email, role) {
  await notify.email({
    workspaceId: workspace.id,
    recipient: email,
    template: 'workspace_invite',
    data: { workspaceName: workspace.name, roleName: role.name },
  });
}

async function createWorkspace({ name, ownerUserId }, req) {
  const baseSlug = toWorkspaceSlug(name);

  return db.sequelize.transaction(async (t) => {
    // Pick a slug that's free right now, then insert it. The pre-check keeps
    // the common "someone already took this store name" case tidy
    // (my-store, my-store-2, …). The retry loop around the insert covers the
    // race where two simultaneous signups with the same name both clear the
    // pre-check and only the DB unique index (workspaces_slug_idx) catches the
    // duplicate — without it the loser's whole signup fails. Same
    // retry-on-unique-index idea as the product code / shipment tracking code.
    // A candidate is unusable either because someone already holds it or
    // because it is one of the labels the platform keeps for itself; both are
    // settled the same way, by falling through to my-store-2, my-store-3, …
    let slug = baseSlug;
    let n = 1;
    while (slugRejectionReason(slug) || (await db.Workspace.findOne({ where: { slug }, transaction: t }))) {
      slug = suffixSlug(baseSlug, ++n);
    }

    let workspace;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        // Savepoint: a duplicate-slug insert only rolls back to here, leaving
        // the outer transaction alive to retry (see orderService.createShipment).
        workspace = await db.sequelize.transaction({ transaction: t }, (sp) =>
          db.Workspace.create({ name, slug, ownerUserId }, { transaction: sp })
        );
        break;
      } catch (err) {
        const clashOnSlug =
          err.name === 'SequelizeUniqueConstraintError' &&
          /slug/.test(`${err.message} ${JSON.stringify(err.fields || {})} ${(err.parent && err.parent.constraint) || ''}`);
        if (clashOnSlug && attempt < 5) {
          slug = suffixSlug(baseSlug, crypto.randomBytes(4).toString('hex'));
          continue;
        }
        throw err;
      }
    }
    if (!workspace) {
      throw new AppError(
        'WORKSPACE_SLUG_UNAVAILABLE',
        'Could not assign a unique store address, please try again',
        503
      );
    }

    // Sequential, not Promise.all: a single Sequelize transaction runs on one
    // pooled connection, and concurrent queries against the same connection
    // are unsafe/undefined behavior in node-postgres.
    const roles = [];
    for (const r of Object.values(SYSTEM_ROLES)) {
      roles.push(
        await db.Role.create(
          { workspaceId: workspace.id, key: r.key, name: r.name, isSystem: true, permissions: r.permissions },
          { transaction: t }
        )
      );
    }
    const ownerRole = roles.find((r) => r.key === 'owner');

    await db.Membership.create(
      { workspaceId: workspace.id, userId: ownerUserId, roleId: ownerRole.id, status: 'active' },
      { transaction: t }
    );

    await db.InvoiceCounter.create({ workspaceId: workspace.id, lastNumber: 0 }, { transaction: t });

    // Every workspace starts on a trialing subscription (no card, no gateway).
    await billingService.ensureSubscriptionForWorkspace(workspace.id, t);

    await recordAudit({
      workspaceId: workspace.id,
      actorUserId: ownerUserId,
      action: 'workspace.create',
      entityType: 'Workspace',
      entityId: workspace.id,
      req,
      transaction: t,
    });

    return workspace;
  });
}

// Known keys inside workspaces.settings that the PATCH endpoint may touch.
// Anything else in that JSONB blob is left alone by an update.
const MERCHANT_SETTINGS_KEYS = [
  'free_shipping_threshold_amount',
  'default_shipping_rate_amount',
  'tax_enabled',
  'default_item_weight_grams',
];

// Nested settings objects, merged a level deeper so a form that toggles one
// switch cannot blank out the sibling keys it never loaded.
const MERCHANT_SETTINGS_OBJECT_KEYS = ['checkout_settings', 'fraud_rules'];

// Merge only the known keys of `patch` onto `current`; a null value clears
// that key (back to "not configured").
function applyMerchantSettings(current, patch) {
  const next = { ...(current || {}) };
  for (const key of MERCHANT_SETTINGS_KEYS) {
    if (!(key in patch)) continue;
    if (patch[key] === null) delete next[key];
    else next[key] = patch[key];
  }
  for (const key of MERCHANT_SETTINGS_OBJECT_KEYS) {
    if (!(key in patch)) continue;
    if (patch[key] === null) {
      delete next[key];
      continue;
    }
    const merged = { ...(next[key] || {}) };
    for (const [subKey, value] of Object.entries(patch[key])) {
      if (value === null) delete merged[subKey];
      else merged[subKey] = value;
    }
    // An object emptied key by key is the same as "not configured".
    if (Object.keys(merged).length === 0) delete next[key];
    else next[key] = merged;
  }
  return next;
}

// PATCH /workspaces/:workspaceId — the merchant's basic store settings.
// name is the workspace name; logoUrl / tagline / themeSettings are storefront
// branding (themeSettings is an opaque blob owned by the frontend, stored
// as-is); settings carries the merchant-tunable shipping/tax knobs.
async function updateWorkspace({ workspaceId, patch }, req) {
  const workspace = await db.Workspace.findByPk(workspaceId);
  if (!workspace) throw new NotFoundError('Workspace');

  // Fraud rules decide which storefront orders get held or refused, so they
  // take workspace.manage on top of the route's website.edit (which an Editor
  // has). Any mention of the key counts, null included, and the whole request
  // is refused before anything in it is written.
  const touchesFraudRules =
    patch.settings && typeof patch.settings === 'object' && Object.prototype.hasOwnProperty.call(patch.settings, 'fraud_rules');
  if (touchesFraudRules && !req.tenant.hasPermission(PERMISSIONS.WORKSPACE_MANAGE)) {
    throw new AuthorizationError('Changing fraud rules requires the workspace.manage permission');
  }

  const before = {
    name: workspace.name,
    slug: workspace.slug,
    logoUrl: workspace.logoUrl,
    tagline: workspace.tagline,
    themeSettings: workspace.themeSettings,
    settings: workspace.settings,
  };

  const next = {};
  if (patch.name !== undefined) next.name = patch.name;
  // Re-submitting the address a store already has is a no-op, not a clash.
  if (patch.slug !== undefined && normalizeSlug(patch.slug) !== workspace.slug) {
    const slug = normalizeSlug(patch.slug);

    // Moving the store's address breaks every link that points at the old one,
    // so it takes workspace.manage — the rest of this PATCH only needs the
    // website.edit the route already requires.
    if (!req.tenant.hasPermission(PERMISSIONS.WORKSPACE_MANAGE)) {
      throw new AuthorizationError('Changing the store address requires the workspace.manage permission');
    }

    // The route's Joi schema already refuses these, so this only catches a
    // caller reaching the service directly.
    const reason = slugRejectionReason(slug);
    if (reason) {
      throw new ValidationError([{ field: 'slug', message: REASON_MESSAGES[reason] }], REASON_MESSAGES[reason]);
    }

    if (await db.Workspace.findOne({ where: { slug }, attributes: ['id'] })) {
      throw new ConflictError(REASON_MESSAGES.taken, 'SLUG_TAKEN');
    }
    next.slug = slug;
  }
  if (patch.logoUrl !== undefined) next.logoUrl = patch.logoUrl || null;
  if (patch.tagline !== undefined) next.tagline = patch.tagline || null;
  if (patch.themeSettings !== undefined) {
    const blob = patch.themeSettings || {};
    if (JSON.stringify(blob).length > 5000) {
      throw new ValidationError(
        [{ field: 'themeSettings', message: 'themeSettings is too large (max ~5KB)' }],
        'themeSettings is too large'
      );
    }
    next.themeSettings = blob;
  }
  if (patch.settings !== undefined) {
    next.settings = applyMerchantSettings(workspace.settings, patch.settings);
    // Tier pricing weighs products without a weight at the default weight;
    // it can't be removed while tier pricing depends on it.
    const clearsDefaultWeight =
      patch.settings && patch.settings.default_item_weight_grams === null && next.settings.shipping_pricing_mode === 'weight_tiers';
    if (clearsDefaultWeight) {
      throw new AppError(
        'DEFAULT_ITEM_WEIGHT_REQUIRED',
        'The default item weight is required while shipping is priced by weight tiers',
        422,
        [{ field: 'settings.default_item_weight_grams', message: 'Required while tier pricing is on' }]
      );
    }
  }

  try {
    await workspace.update(next);
  } catch (err) {
    // Two merchants claiming the same address at once: only the unique index
    // sees the loser, and it reads as the same 409 as losing the pre-check.
    const clashOnSlug =
      err.name === 'SequelizeUniqueConstraintError' &&
      /slug/.test(`${err.message} ${JSON.stringify(err.fields || {})} ${(err.parent && err.parent.constraint) || ''}`);
    if (clashOnSlug) throw new ConflictError(REASON_MESSAGES.taken, 'SLUG_TAKEN');
    throw err;
  }

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'workspace.update',
    entityType: 'Workspace',
    entityId: workspaceId,
    before,
    after: {
      name: workspace.name,
      slug: workspace.slug,
      logoUrl: workspace.logoUrl,
      tagline: workspace.tagline,
      themeSettings: workspace.themeSettings,
      settings: workspace.settings,
    },
    req,
  });

  return workspace;
}

/**
 * Is `slug` free for a merchant to take? Returns exactly what
 * GET /workspaces/check-slug emits: { available, reason? }, where reason is a
 * stable key ('taken', 'reserved', 'too_short', 'too_long', 'invalid_format').
 */
async function checkSlugAvailability(rawSlug) {
  const slug = normalizeSlug(rawSlug);

  const reason = slugRejectionReason(slug);
  if (reason) return { available: false, reason };

  const existing = await db.Workspace.findOne({ where: { slug }, attributes: ['id'] });
  return existing ? { available: false, reason: 'taken' } : { available: true };
}

async function listWorkspacesForUser(userId) {
  const memberships = await db.Membership.findAll({
    where: { userId, status: 'active' },
    include: [
      { model: db.Workspace, as: 'workspace' },
      { model: db.Role, as: 'role' },
    ],
  });
  return memberships.map((m) => ({
    workspace: m.workspace,
    role: { key: m.role.key, name: m.role.name },
  }));
}

async function inviteMember({ workspaceId, email, roleId }, req) {
  const role = await db.Role.findOne({ where: { id: roleId, workspaceId } });
  if (!role) throw new NotFoundError('Role');

  const user = await db.User.findOne({ where: { email } });

  if (user) {
    const existing = await db.Membership.findOne({ where: { workspaceId, userId: user.id } });
    if (existing) throw new ConflictError('User is already a member of this workspace', 'ALREADY_MEMBER');
  } else {
    const pending = await db.Membership.findOne({ where: { workspaceId, invitedEmail: email } });
    if (pending) throw new ConflictError('That email already has a pending invite', 'ALREADY_INVITED');
  }

  const membership = await db.Membership.create({
    workspaceId,
    userId: user ? user.id : null,
    roleId,
    status: user ? 'active' : 'invited',
    invitedEmail: user ? null : email,
  });

  const workspace = await db.Workspace.findByPk(workspaceId);
  await sendInviteEmail(workspace, email, role);

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'membership.invite',
    entityType: 'Membership',
    entityId: membership.id,
    after: { email, roleId },
    req,
  });

  return membership;
}

async function listMembers(workspaceId) {
  return db.Membership.findAll({
    where: { workspaceId },
    include: [
      { model: db.User, as: 'user', attributes: ['id', 'email', 'fullName', 'status'] },
      { model: db.Role, as: 'role', attributes: ['id', 'key', 'name'] },
    ],
    order: [['createdAt', 'ASC']],
  });
}

async function listPendingInvites(workspaceId) {
  return db.Membership.findAll({
    where: { workspaceId, status: 'invited' },
    include: [{ model: db.Role, as: 'role', attributes: ['id', 'key', 'name'] }],
    order: [['createdAt', 'ASC']],
  });
}

async function resendInvite({ workspaceId, membershipId }, req) {
  const membership = await db.Membership.findOne({
    where: { id: membershipId, workspaceId },
    include: [{ model: db.Role, as: 'role' }],
  });
  if (!membership) throw new NotFoundError('Membership');
  if (membership.status !== 'invited') {
    throw new AppError('NOT_PENDING', 'That invite has already been accepted', 409);
  }

  const workspace = await db.Workspace.findByPk(workspaceId);
  await sendInviteEmail(workspace, membership.invitedEmail, membership.role);

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'membership.invite_resend',
    entityType: 'Membership',
    entityId: membership.id,
    after: { email: membership.invitedEmail },
    req,
  });

  return { resent: true, email: membership.invitedEmail };
}

async function updateMemberRole({ workspaceId, membershipId, roleId }, req) {
  const membership = await db.Membership.findOne({ where: { id: membershipId, workspaceId } });
  if (!membership) throw new NotFoundError('Membership');

  const role = await db.Role.findOne({ where: { id: roleId, workspaceId } });
  if (!role) throw new NotFoundError('Role');

  const targetOwnerRole = await db.Role.findOne({ where: { workspaceId, key: 'owner' } });
  if (membership.roleId === targetOwnerRole.id && role.id !== targetOwnerRole.id) {
    const ownerCount = await db.Membership.count({ where: { workspaceId, roleId: targetOwnerRole.id, status: 'active' } });
    if (ownerCount <= 1) {
      throw new AppError('LAST_OWNER', 'Cannot remove the last Owner of a workspace', 409);
    }
  }

  const before = { roleId: membership.roleId };
  await membership.update({ roleId });

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'membership.role_change',
    entityType: 'Membership',
    entityId: membership.id,
    before,
    after: { roleId },
    req,
  });

  return membership;
}

async function removeMember({ workspaceId, membershipId }, req) {
  const membership = await db.Membership.findOne({ where: { id: membershipId, workspaceId }, include: [{ model: db.Role, as: 'role' }] });
  if (!membership) throw new NotFoundError('Membership');

  if (membership.role.key === 'owner') {
    const ownerCount = await db.Membership.count({
      where: { workspaceId, status: 'active' },
      include: [{ model: db.Role, as: 'role', where: { key: 'owner' } }],
    });
    if (ownerCount <= 1) {
      throw new AppError('LAST_OWNER', 'Cannot remove the last Owner of a workspace', 409);
    }
  }

  await membership.destroy();

  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'membership.remove',
    entityType: 'Membership',
    entityId: membershipId,
    req,
  });

  return { success: true };
}

async function listRoles(workspaceId) {
  return db.Role.findAll({ where: { workspaceId }, order: [['isSystem', 'DESC'], ['name', 'ASC']] });
}

async function createCustomRole({ workspaceId, name, key, permissions }, req) {
  const role = await db.Role.create({ workspaceId, key, name, isSystem: false, permissions });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: 'role.create',
    entityType: 'Role',
    entityId: role.id,
    after: { name, key, permissions },
    req,
  });
  return role;
}

module.exports = {
  createWorkspace,
  updateWorkspace,
  checkSlugAvailability,
  listWorkspacesForUser,
  inviteMember,
  listMembers,
  listPendingInvites,
  resendInvite,
  updateMemberRole,
  removeMember,
  listRoles,
  createCustomRole,
};
