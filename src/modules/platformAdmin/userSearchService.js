'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const access = require('../workspaces/workspaceAccessService');
const siteTraffic = require('../siteAnalytics/siteTrafficService');
const primaryHost = require('../domains/primaryHost');

/**
 * The platform console's user search (GET /admin/users?q=). One box finds an
 * account by:
 *   - its name — Arabic folded by zimos_normalize_search (migration 088), so
 *     "احمد" finds "أحمد";
 *   - its username or email (contains);
 *   - its id: the whole UUID, or its first 8+ characters;
 *   - a store it owns or belongs to: the store's name (folded), slug, a site
 *     subdomain, or the store's id — the "reverse" search: type a store and
 *     get the people behind it.
 * Each account is listed once however many ways it matched, newest first,
 * a page at a time, with its stores (role and subscription state) and which
 * of them matched. Every value is a bind parameter. The trigram indexes of
 * migration 124 carry the "contains" matches.
 *
 * Deleted accounts (deleted_at set) are left out unless includeDeleted=true.
 *
 * Who may search: the platform permission the store list uses
 * (workspaces.view — creators and admins). An agent has never had it and still
 * does not; agents see their own referred stores through /my/referrals only.
 */

const MAX_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_PREFIX = /^[0-9a-f]{8}[0-9a-f-]{0,27}$/i;

const escapeLike = (value) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

function termsFor(q) {
  const term = String(q || '').trim();
  if (!term) return null;
  const lower = term.toLowerCase();
  return {
    like: `%${escapeLike(term)}%`,
    likeLower: `%${escapeLike(lower)}%`,
    idExact: UUID.test(term) ? lower : null,
    idPrefix: !UUID.test(term) && ID_PREFIX.test(term) ? `${escapeLike(lower)}%` : null,
  };
}

// Conditions on a store row `w`, shared by the owner and member arms.
const WORKSPACE_MATCH = `(
  zimos_normalize_search(w.name) LIKE zimos_normalize_search($like)
  OR w.slug LIKE $likeLower
  OR ($idExact::uuid IS NOT NULL AND w.id = $idExact::uuid)
  OR ($idPrefix::text IS NOT NULL AND w.id::text LIKE $idPrefix)
  OR EXISTS (SELECT 1 FROM websites s WHERE s.workspace_id = w.id AND s.subdomain LIKE $likeLower)
)`;

const USER_MATCH = `(
  zimos_normalize_search(u.full_name) LIKE zimos_normalize_search($like)
  OR u.username LIKE $likeLower
  OR lower(u.email::text) LIKE $likeLower
  OR ($idExact::uuid IS NOT NULL AND u.id = $idExact::uuid)
  OR ($idPrefix::text IS NOT NULL AND u.id::text LIKE $idPrefix)
)`;

// Keeps deleted accounts out of the list unless they were asked for.
const LISTED = '($includeDeleted::boolean OR u.deleted_at IS NULL)';

async function matchingIds({ q, limit, offset, includeDeleted }) {
  const terms = termsFor(q);
  if (!terms) {
    const [{ total }] = await db.sequelize.query(`SELECT COUNT(*)::int AS total FROM users u WHERE ${LISTED}`, {
      bind: { includeDeleted },
      type: QueryTypes.SELECT,
    });
    const rows = await db.sequelize.query(
      `SELECT u.id FROM users u WHERE ${LISTED} ORDER BY u.created_at DESC, u.id DESC LIMIT $limit OFFSET $offset`,
      { bind: { limit, offset, includeDeleted }, type: QueryTypes.SELECT }
    );
    return { total, ids: rows.map((r) => r.id), matchedWorkspaces: new Set() };
  }

  const bind = { ...terms, limit, offset, includeDeleted };
  const matched = `
    SELECT u.id FROM users u WHERE ${USER_MATCH}
    UNION
    SELECT w.owner_user_id FROM workspaces w WHERE ${WORKSPACE_MATCH}
    UNION
    SELECT m.user_id FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id IS NOT NULL AND ${WORKSPACE_MATCH}`;
  const [{ total }] = await db.sequelize.query(
    `SELECT COUNT(*)::int AS total FROM users u JOIN (${matched}) x ON x.id = u.id WHERE ${LISTED}`,
    { bind, type: QueryTypes.SELECT }
  );
  const rows = await db.sequelize.query(
    `SELECT u.id FROM users u JOIN (${matched}) x ON x.id = u.id WHERE ${LISTED}
      ORDER BY u.created_at DESC, u.id DESC LIMIT $limit OFFSET $offset`,
    { bind, type: QueryTypes.SELECT }
  );
  const stores = await db.sequelize.query(`SELECT w.id FROM workspaces w WHERE ${WORKSPACE_MATCH}`, {
    bind,
    type: QueryTypes.SELECT,
  });
  return { total, ids: rows.map((r) => r.id), matchedWorkspaces: new Set(stores.map((s) => s.id)) };
}

function subscriptionSummary(subscription, now) {
  if (!subscription) return null;
  const lifecycle = access.billingLifecycle(subscription, now);
  return {
    status: lifecycle.status,
    phase: lifecycle.phase,
    plan: subscription.plan ? subscription.plan.name : null,
    planId: subscription.planId,
    currentPeriodEnd: subscription.currentPeriodEnd,
  };
}

/**
 * Each user's stores: owned ones, then the ones they are a member of, each
 * with the link that opens it (domains/primaryHost: the primary domain when it
 * can be served, else the platform subdomain), all in one more query.
 */
async function storesFor(userIds, matchedWorkspaces) {
  if (userIds.length === 0) return new Map();
  const include = [{ model: db.Subscription, as: 'subscription', include: [{ model: db.Plan, as: 'plan', attributes: ['id', 'name'] }] }];
  const owned = await db.Workspace.findAll({
    where: { ownerUserId: userIds },
    attributes: ['id', 'name', 'slug', 'status', 'ownerUserId', 'createdAt'],
    include,
    order: [['createdAt', 'ASC']],
  });
  const memberships = await db.Membership.findAll({
    where: { userId: userIds, status: 'active' },
    include: [
      { model: db.Role, as: 'role', attributes: ['key', 'name'] },
      { model: db.Workspace, as: 'workspace', attributes: ['id', 'name', 'slug', 'status', 'ownerUserId', 'createdAt'], include },
    ],
  });
  const origins = await primaryHost.storeOriginsOf([...owned, ...memberships.map((m) => m.workspace)]);
  const now = new Date();
  const byUser = new Map(userIds.map((id) => [id, []]));
  const row = (w, role) => ({
    id: w.id,
    name: w.name,
    slug: w.slug,
    status: w.status,
    role,
    createdAt: w.createdAt,
    storeUrl: origins.get(w.id) || null,
    matched: matchedWorkspaces.has(w.id),
    subscription: subscriptionSummary(w.subscription, now),
  });
  for (const w of owned) byUser.get(w.ownerUserId).push(row(w, 'owner'));
  for (const m of memberships) {
    if (!m.workspace || m.workspace.ownerUserId === m.userId) continue;
    byUser.get(m.userId).push(row(m.workspace, m.role ? m.role.key : 'member'));
  }
  return byUser;
}

const USER_ATTRIBUTES = ['id', 'username', 'fullName', 'email', 'status', 'platformRole', 'createdAt', 'lastLoginAt', 'emailVerifiedAt', 'deletedAt'];

function toRow(user, stores) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    email: user.email,
    status: user.status,
    platformRole: user.platformRole,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    emailVerified: Boolean(user.emailVerifiedAt),
    deleted: Boolean(user.deletedAt),
    workspaces: stores || [],
  };
}

/** GET /admin/users?q=&page=&limit=&includeDeleted= */
async function searchUsers({ q = '', page = 1, limit = 25, includeDeleted = false } = {}) {
  const size = Math.min(Math.max(Number(limit) || 25, 1), MAX_LIMIT);
  const pageNo = Math.max(Number(page) || 1, 1);
  const { total, ids, matchedWorkspaces } = await matchingIds({
    q,
    limit: size,
    offset: (pageNo - 1) * size,
    includeDeleted: includeDeleted === true,
  });
  const users = ids.length ? await db.User.findAll({ where: { id: ids }, attributes: USER_ATTRIBUTES }) : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const stores = await storesFor(ids, matchedWorkspaces);
  return {
    users: ids.filter((id) => byId.has(id)).map((id) => toRow(byId.get(id), stores.get(id))),
    page: pageNo,
    limit: size,
    total,
    hasMore: pageNo * size < total,
  };
}

/** GET /admin/users/:userId */
async function getUser(userId) {
  const user = await db.User.findByPk(userId, {
    attributes: [...USER_ATTRIBUTES, 'phone', 'phoneVerifiedAt', 'usernameChangedAt', 'suspendedAt', 'suspendedReason'],
  });
  if (!user) throw new NotFoundError('User');
  const stores = await storesFor([user.id], new Set());
  return {
    ...toRow(user, stores.get(user.id)),
    phone: user.phone,
    phoneVerified: Boolean(user.phoneVerifiedAt),
    usernameChangedAt: user.usernameChangedAt,
    suspendedAt: user.suspendedAt,
    suspendedReason: user.suspendedReason,
    deletedAt: user.deletedAt,
    acquisition: await siteTraffic.acquisitionFor(user.id),
    // Approximate, from the marketing-site visits they signed up from; null when none carries one.
    location: await siteTraffic.locationFor(user.id),
  };
}

module.exports = { searchUsers, getUser, MAX_LIMIT };
