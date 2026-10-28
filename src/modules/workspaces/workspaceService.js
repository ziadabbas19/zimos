'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
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
const entitlements = require('../billing/entitlementsService');
const publicPlans = require('../billing/publicPlansService');
const { isVerified } = require('../auth/signupPolicy');
const env = require('../../config/env');
const { assertBumpOfferUsable } = require('../checkout/orderBump');
const { checkLogoUrl } = require('./workspaceLogo');
const invites = require('./inviteAcceptance');

/**
 * `token` is the accept link's for a pending invite; null when an existing
 * account was added at once (its email says so and links to the dashboard).
 */
async function sendInviteEmail(workspace, email, role, token = null) {
  await notify.email({
    workspaceId: workspace.id,
    recipient: email,
    template: 'workspace_invite',
    data: {
      workspaceName: workspace.name,
      roleName: role.name,
      email,
      ...(token ? { token, expiresInDays: invites.INVITE_TTL_DAYS } : {}),
    },
  });
}

/**
 * The plan a new store starts on. With REQUIRE_PLAN_AT_SIGNUP off it is the
 * default plan (the cheapest active one), as it always was, whatever the
 * request says. With it on: the plan the request names, which must be on
 * offer; otherwise, for someone's first store, the plan they chose at
 * sign-up; otherwise the default. An account made through Google that has
 * still to choose a plan (auth/signupPolicy) must name one.
 */
async function planForNewStore({ ownerUserId, planId, billingCycle }, transaction) {
  if (!env.signup.requirePlan) return { plan: await billingService.defaultPlan(transaction), billingCycle: 'monthly' };
  if (planId) {
    return { plan: await publicPlans.findOfferedPlan(planId, transaction), billingCycle: billingCycle || 'monthly' };
  }
  const owner = await db.User.findByPk(ownerUserId, {
    attributes: ['id', 'selectedPlanId', 'selectedBillingCycle', 'requiresPlanSelection'],
    transaction,
  });
  if (owner && owner.requiresPlanSelection && !owner.selectedPlanId && (await publicPlans.anyOffered(transaction))) {
    throw new AppError('PLAN_REQUIRED', 'Choose a plan first', 422, [{ field: 'planId', message: 'Choose a plan' }]);
  }
  if (owner && owner.selectedPlanId && (await db.Workspace.count({ where: { ownerUserId }, transaction })) === 0) {
    const chosen = await db.Plan.findByPk(owner.selectedPlanId, { transaction });
    if (chosen && chosen.isActive) {
      return { plan: chosen, billingCycle: billingCycle || owner.selectedBillingCycle || 'monthly' };
    }
  }
  return { plan: await billingService.defaultPlan(transaction), billingCycle: billingCycle || 'monthly' };
}

async function createWorkspace({ name, ownerUserId, referralCode = null, planId = null, billingCycle = null }, req) {
  const baseSlug = toWorkspaceSlug(name);

  return db.sequelize.transaction(async (t) => {
    // The plan first, then the owner's store limit for it (billing/
    // entitlementsService), under a lock on the owner held until this
    // transaction ends: two stores created at once cannot both pass.
    const start = await planForNewStore({ ownerUserId, planId, billingCycle }, t);
    await entitlements.assertCanCreateStore(ownerUserId, start.plan, { transaction: t });

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

    // Every workspace starts on a trialing subscription (no card, no
    // gateway) — or, while REQUIRE_SUBSCRIPTION_TO_GO_LIVE is on, as a draft.
    await billingService.ensureSubscriptionForWorkspace(workspace.id, t, {
      plan: start.plan,
      billingCycle: start.billingCycle,
      ownerUserId,
    });

    await recordAudit({
      workspaceId: workspace.id,
      actorUserId: ownerUserId,
      action: 'workspace.create',
      entityType: 'Workspace',
      entityId: workspace.id,
      req,
      transaction: t,
    });

    // The subscription starts here, so this is where an agent's referral code
    // is entered first. A code that is not usable rolls the whole creation
    // back with REFERRAL_CODE_INVALID, so the merchant can correct it.
    if (referralCode) {
      await billingService.attachReferralCodeInTransaction(workspace.id, referralCode, req, t, {
        source: 'signup',
        planId: start.plan ? start.plan.id : null,
        billingCycle: start.billingCycle,
      });
    }

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
  'confirmation_whatsapp_template',
  // Replaced whole, not merged: its filter list is ordered.
  'storefront_catalog',
  // Replaced whole: { enabled, offer_id, title, description }.
  'order_bump',
  // Funnel upsells joined to the checkout order (funnels/funnelOfferMerge.js).
  'funnel_upsell_merge',
  'funnel_offer_window_minutes',
  // Replaced whole: the browser ad-pixel IDs (public, no secrets).
  'tracking_pixels',
  // Replaced whole: the thank-you page (storefront/thankYouPage.js).
  'thank_you_page',
  // Replaced whole: store details + short policies, and the legal policies
  // (storefront/storeInfo.js).
  'store_info',
  'legal',
  // Replaced whole: storefront/generalSettings.js.
  'general',
  'social_links',
  'floating_whatsapp',
  'store_seo',
  // Replaced whole: the store's extra languages (modules/translations).
  'store_languages',
];

// The keys above that price delivery; changing them takes shipping.manage.
const SHIPPING_SETTINGS_KEYS = ['free_shipping_threshold_amount', 'default_shipping_rate_amount', 'default_item_weight_grams'];

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
  // The confirmation team's WhatsApp message is theirs to manage: an Editor's
  // website.edit is not enough.
  const touchesWhatsappTemplate =
    patch.settings &&
    typeof patch.settings === 'object' &&
    Object.prototype.hasOwnProperty.call(patch.settings, 'confirmation_whatsapp_template');
  if (touchesWhatsappTemplate && !req.tenant.hasPermission(PERMISSIONS.ORDERS_MANAGE)) {
    throw new AuthorizationError('Changing the WhatsApp confirmation message requires the orders.manage permission');
  }
  // Whether funnel orders wait for their offers before confirmation changes
  // how the confirmation team works: theirs too.
  const touchesFunnelMerge =
    patch.settings &&
    typeof patch.settings === 'object' &&
    ['funnel_upsell_merge', 'funnel_offer_window_minutes'].some((key) => Object.prototype.hasOwnProperty.call(patch.settings, key));
  if (touchesFunnelMerge && !req.tenant.hasPermission(PERMISSIONS.ORDERS_MANAGE)) {
    throw new AuthorizationError('Changing how funnel upsells join orders requires the orders.manage permission');
  }
  // What every order is charged for delivery. The shipping settings endpoint
  // that writes these same keys takes shipping.manage (shipping/shippingRoutes),
  // so this second way in does too.
  const touchesShipping =
    patch.settings && typeof patch.settings === 'object' && SHIPPING_SETTINGS_KEYS.some((key) => Object.prototype.hasOwnProperty.call(patch.settings, key));
  if (touchesShipping && !req.tenant.hasPermission(PERMISSIONS.SHIPPING_MANAGE)) {
    throw new AuthorizationError('Changing shipping settings requires the shipping.manage permission');
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
  if (patch.logoUrl !== undefined) {
    checkLogoUrl(patch.logoUrl);
    next.logoUrl = patch.logoUrl || null;
  }
  if (patch.tagline !== undefined) next.tagline = patch.tagline || null;
  if (patch.themeSettings !== undefined) {
    const blob = patch.themeSettings || {};
    if (JSON.stringify(blob).length > 5000) {
      throw new ValidationError(
        [{ field: 'themeSettings', message: 'themeSettings is too large (max ~5KB)' }],
        'themeSettings is too large'
      );
    }
    // A paid or withdrawn theme can't be switched on this way either (themes/themesCatalog.js).
    await require('../themes/themesCatalog').assertThemeAllowed(
      workspaceId,
      blob.storeTheme,
      (workspace.themeSettings && workspace.themeSettings.storeTheme) || 'original'
    );
    next.themeSettings = blob;
  }
  if (patch.settings !== undefined) {
    // A bump that is switched on must name an offer that can be one (active,
    // priced, asks the shopper nothing) in this workspace.
    const bump = patch.settings && patch.settings.order_bump;
    if (bump && bump.enabled) {
      await assertBumpOfferUsable(workspaceId, bump.offer_id, 'settings.order_bump.offer_id');
    }
    next.settings = applyMerchantSettings(workspace.settings, patch.settings);
    // Phone codes switched on (or a rule asking for one) need a channel that delivers them
    // (CHECKOUT_OTP_DELIVERY_GUARD_ENABLED; off, nothing is checked).
    if (touchesFraudRules) require('../risk/checkoutOtp').assertDeliverable(workspace.settings, next.settings);
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
  // The role's permissions as resolveTenant reads them ('*' = every one): the
  // dashboard shows a page only to a role its API lets in (lib/navigation).
  return memberships.map((m) => ({
    workspace: m.workspace,
    role: { key: m.role.key, name: m.role.name, permissions: m.role.permissions || [] },
  }));
}

/**
 * Nobody hands out more access than they hold: a role with '*' (Owner) only
 * by someone who holds '*', any other role only when the caller holds every
 * permission in it. Checked for invites, role changes and new custom roles.
 * The teammate's current role is checked only for Owner access
 * (assertCanChangeHolder), so an Admin can neither make themselves Owner nor
 * demote or remove one, but can still re-role or remove a teammate whose role
 * holds a permission the Admin lacks.
 */
function assertCanGrant(rolePermissions, req) {
  const permissions = rolePermissions || [];
  if (permissions.includes('*')) {
    const callerIsOwner = ((req.tenant.role && req.tenant.role.permissions) || []).includes('*');
    if (!callerIsOwner) throw new AppError('ROLE_ABOVE_YOURS', 'Only an Owner can give, change or remove Owner access', 403);
    return;
  }
  const beyond = [...new Set(permissions.filter((p) => !req.tenant.hasPermission(p)))];
  if (beyond.length > 0) {
    throw new AppError('ROLE_ABOVE_YOURS', `You cannot give or change access you do not have: ${beyond.join(', ')}`, 403, [
      { field: 'permissions', message: `Not held by you: ${beyond.join(', ')}` },
    ]);
  }
}

/** Changing or removing a teammate: only their Owner access needs an Owner. */
function assertCanChangeHolder(rolePermissions, req) {
  if ((rolePermissions || []).includes('*')) assertCanGrant(rolePermissions, req);
}

/**
 * The acting member as they are now, read under a row lock in the caller's
 * transaction, as the request's own `req.tenant` (core/middleware/tenantContext)
 * was built before it: their active membership and the permissions of the
 * role it names. Who may invite, re-role or define a role is decided on this,
 * not on the copy the request arrived with — a member demoted or removed a
 * moment ago must not finish a change that was already in flight.
 *
 * `alsoLock` names more memberships of the workspace to lock in the same
 * statement. Every row is taken in id order, so two members changing each
 * other at the same moment wait for one another instead of deadlocking.
 */
async function actorUnderLock(workspaceId, req, transaction, permission, alsoLock = []) {
  const rows = await db.Membership.findAll({
    where: { workspaceId, [Op.or]: [{ userId: req.user.id, status: 'active' }, ...alsoLock] },
    order: [['id', 'ASC']],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  const membership = rows.find((m) => m.userId === req.user.id && m.status === 'active');
  const role = membership ? await db.Role.findOne({ where: { id: membership.roleId, workspaceId }, transaction }) : null;
  const permissions = (role && role.permissions) || [];
  const hasPermission = (p) => permissions.includes('*') || permissions.includes(p);
  if (!membership || !hasPermission(permission)) {
    throw new AuthorizationError(`Missing required permission: ${permission}`);
  }
  return { rows, actor: { tenant: { workspaceId, membership, role, hasPermission } } };
}

async function inviteMember({ workspaceId, email, roleId }, req) {
  const { membership, role, token } = await db.sequelize.transaction(async (transaction) => {
    const { actor } = await actorUnderLock(workspaceId, req, transaction, PERMISSIONS.USERS_MANAGE);
    const invitedRole = await db.Role.findOne({ where: { id: roleId, workspaceId }, transaction });
    if (!invitedRole) throw new NotFoundError('Role');
    assertCanGrant(invitedRole.permissions, actor);

    const user = await db.User.findOne({ where: { email }, transaction });

    if (user) {
      // An existing account becomes a member at once, so it must have confirmed
      // its email: a new account is signed in before it does, and anyone can
      // sign up with an address they don't own.
      if (!isVerified(user)) {
        throw new ConflictError(
          "That person's account hasn't confirmed its email yet. Ask them to confirm it, then invite them again.",
          'INVITEE_NOT_CONFIRMED'
        );
      }
      const existing = await db.Membership.findOne({ where: { workspaceId, userId: user.id }, transaction });
      if (existing) throw new ConflictError('User is already a member of this workspace', 'ALREADY_MEMBER');
    } else {
      const pending = await db.Membership.findOne({
        where: { workspaceId, status: 'invited', [Op.and]: [invites.invitedEmailIs(email)] },
        transaction,
      });
      if (pending) throw new ConflictError('That email already has a pending invite', 'ALREADY_INVITED');
    }

    // Anyone else gets a pending membership and a link to accept it with
    // (workspaces/inviteAcceptance.js).
    const link = user ? null : invites.newInviteToken();
    const created = await db.Membership.create(
      {
        workspaceId,
        userId: user ? user.id : null,
        roleId,
        status: user ? 'active' : 'invited',
        invitedEmail: user ? null : invites.normalizeEmail(email),
        ...(link ? link.fields : {}),
      },
      { transaction }
    );
    return { membership: created, role: invitedRole, token: link ? link.token : null };
  });

  // Once the membership exists: no email for an invite that was refused, and
  // no row lock held while the email is sent.
  const workspace = await db.Workspace.findByPk(workspaceId);
  await sendInviteEmail(workspace, email, role, token);

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

  // A fresh link that works for the full period again; the previous one stops
  // working (an invite sent before migration 726 gets its first link here).
  const link = invites.newInviteToken();
  await membership.update(link.fields);

  const workspace = await db.Workspace.findByPk(workspaceId);
  await sendInviteEmail(workspace, membership.invitedEmail, membership.role, link.token);

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
  return db.sequelize.transaction(async (transaction) => {
    const ownerRole = await db.Role.findOne({ where: { workspaceId, key: 'owner' }, transaction });
    // The teammate and every Owner are locked with the requester: the count of
    // Owners below is of rows nobody else can be changing.
    const { rows, actor } = await actorUnderLock(workspaceId, req, transaction, PERMISSIONS.USERS_MANAGE, [
      { id: membershipId },
      ...(ownerRole ? [{ roleId: ownerRole.id, status: 'active' }] : []),
    ]);
    // Postgres matches a uuid in any case; compare the canonical form.
    const membership = rows.find((m) => m.id === String(membershipId).toLowerCase());
    if (!membership) throw new NotFoundError('Membership');
    const currentRole = await db.Role.findOne({ where: { id: membership.roleId, workspaceId }, transaction });

    const role = await db.Role.findOne({ where: { id: roleId, workspaceId }, transaction });
    if (!role) throw new NotFoundError('Role');
    // Both ends: the teammate's current Owner access and the role they get.
    assertCanChangeHolder(currentRole && currentRole.permissions, actor);
    assertCanGrant(role.permissions, actor);

    if (ownerRole && membership.roleId === ownerRole.id && role.id !== ownerRole.id) {
      const ownerCount = rows.filter((m) => m.roleId === ownerRole.id && m.status === 'active').length;
      if (ownerCount <= 1) {
        throw new AppError('LAST_OWNER', 'Cannot remove the last Owner of a workspace', 409);
      }
    }

    const before = { roleId: membership.roleId };
    await membership.update({ roleId }, { transaction });

    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'membership.role_change',
      entityType: 'Membership',
      entityId: membership.id,
      before,
      after: { roleId },
      req,
      transaction,
    });

    // With the role it now has, as the member list shows it.
    membership.setDataValue('role', role);
    return membership;
  });
}
async function removeMember({ workspaceId, membershipId }, req) {
  const membership = await db.Membership.findOne({ where: { id: membershipId, workspaceId }, include: [{ model: db.Role, as: 'role' }] });
  if (!membership) throw new NotFoundError('Membership');
  assertCanChangeHolder(membership.role.permissions, req);

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
  return db.sequelize.transaction(async (transaction) => {
    const { actor } = await actorUnderLock(workspaceId, req, transaction, PERMISSIONS.ROLES_MANAGE);
    assertCanGrant(permissions, actor);
    const role = await db.Role.create({ workspaceId, key, name, isSystem: false, permissions }, { transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'role.create',
      entityType: 'Role',
      entityId: role.id,
      after: { name, key, permissions },
      req,
      transaction,
    });
    return role;
  });
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
  assertCanGrant,
};
