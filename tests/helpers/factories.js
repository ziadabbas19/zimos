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

  const res = await request(app).post('/api/v1/auth/register').send({ email, password, fullName });
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

module.exports = {
  app,
  request,
  uniqueEmail,
  registerAndActivate,
  createWorkspace,
  createProductWithVariant,
  setupWorkspaceWithProduct,
};
