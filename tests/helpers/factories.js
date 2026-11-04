'use strict';

const request = require('supertest');
const app = require('../../src/app');
const db = require('../../src/db/models');

let counter = 0;
function uniqueEmail(prefix = 'user') {
  counter += 1;
  return `${prefix}${Date.now()}${counter}@example.com`;
}

/**
 * Registers a user through the real HTTP endpoint, then activates the
 * account directly via the DB (standing in for clicking an emailed
 * verification link, since the notification provider in tests is the
 * console/mock provider with no real inbox to read from).
 */
async function registerAndActivate(overrides = {}) {
  const email = overrides.email || uniqueEmail();
  const password = overrides.password || 'Passw0rd!123';
  const fullName = overrides.fullName || 'Test User';

  const res = await request(app).post('/api/v1/auth/register').send({ phone: '01012345678', email, password, fullName });
  if (res.status !== 201) {
    throw new Error(`registerAndActivate failed: ${res.status} ${JSON.stringify(res.body)}`);
  }

  await db.User.update({ status: 'active', emailVerifiedAt: new Date() }, { where: { email } });

  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password });
  if (loginRes.status !== 200) {
    throw new Error(`registerAndActivate login failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }
  return { email, password, userId: res.body.user.id, ...loginRes.body };
}

async function createWorkspace(accessToken, name = 'Test Workspace') {
  const res = await request(app)
    .post('/api/v1/workspaces')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ name });
  if (res.status !== 201) {
    throw new Error(`createWorkspace failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.workspace;
}

async function createProductWithVariant(accessToken, workspaceId, { price = 10000, stock = 10, sku } = {}) {
  const productRes = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/catalog/products`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ name: 'Test Product', status: 'active' });
  if (productRes.status !== 201) {
    throw new Error(`createProduct failed: ${productRes.status} ${JSON.stringify(productRes.body)}`);
  }
  const product = productRes.body.product;

  const variantRes = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/catalog/products/${product.id}/variants`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ sku: sku || `SKU-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, priceAmount: price, stockOnHand: stock });
  if (variantRes.status !== 201) {
    throw new Error(`createVariant failed: ${variantRes.status} ${JSON.stringify(variantRes.body)}`);
  }

  return { product, variant: variantRes.body.variant };
}

/** Full setup: a fresh user owning a fresh workspace with one stocked variant. */
async function setupWorkspaceWithProduct(opts = {}) {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, opts.workspaceName);
  const { product, variant } = await createProductWithVariant(auth.accessToken, workspace.id, opts);
  return { auth, workspace, product, variant };
}

/** A fresh user added to `workspaceId` with one of its system roles (by key). */
async function addMemberWithRole(ownerToken, workspaceId, roleKey, fullName = 'Team Member') {
  const member = await registerAndActivate({ fullName });
  const role = await db.Role.findOne({ where: { workspaceId, key: roleKey } });
  if (!role) throw new Error(`addMemberWithRole: no role ${roleKey}`);
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/members`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ email: member.email, roleId: role.id });
  if (res.status !== 201) {
    throw new Error(`addMemberWithRole failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return member;
}

/**
 * Confirms a COD order from the order page, as a merchant would before
 * shipping it: every shipment path requires a confirmed COD order.
 */
async function confirmCodOrder(accessToken, workspaceId, orderId) {
  const res = await request(app)
    .post(`/api/v1/workspaces/${workspaceId}/orders/${orderId}/confirmation`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({});
  if (res.status !== 200) {
    throw new Error(`confirmCodOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

/**
 * Gives an existing account a platform-console role with that role's default
 * permission set, straight in the DB — the out-of-band way the first creator
 * is made (scripts/set-platform-role.js). The roles themselves are seeded by
 * migration 105 and survive the per-test truncate.
 */
async function setPlatformRole(userId, roleKey = 'admin') {
  const role = await db.PlatformRole.findByPk(roleKey);
  if (!role) throw new Error(`setPlatformRole: no platform role ${roleKey}`);
  await db.User.update(
    { platformRole: role.key, platformPermissions: role.defaultPermissions },
    { where: { id: userId } }
  );
}

/** Adds keys to an account's set, as a creator does by hand: what no role holds by default. */
async function addPlatformKeys(userId, keys) {
  const user = await db.User.findByPk(userId);
  await user.update({ platformPermissions: [...new Set([...user.platformPermissions, ...keys])] });
}

/** A fresh active account holding `roleKey`, with a ready Authorization header. */
async function makePlatformUser(roleKey = 'admin', overrides = {}) {
  const auth = await registerAndActivate(overrides);
  await setPlatformRole(auth.userId, roleKey);
  return { ...auth, H: { Authorization: `Bearer ${auth.accessToken}` } };
}

module.exports = {
  addMemberWithRole,
  confirmCodOrder,
  setPlatformRole,
  addPlatformKeys,
  makePlatformUser,
  app,
  request,
  uniqueEmail,
  registerAndActivate,
  createWorkspace,
  createProductWithVariant,
  setupWorkspaceWithProduct,
};
