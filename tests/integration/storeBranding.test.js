'use strict';

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const env = require('../../src/config/env');

async function setup(name = 'Brand Co') {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, name);
  return { auth, workspace, wid: workspace.id, H: { Authorization: `Bearer ${auth.accessToken}` } };
}

function addProduct(wid, H, over = {}) {
  return request(app)
    .post(`/api/v1/workspaces/${wid}/quickstart`)
    .set(H)
    .type('form')
    .send({ productName: 'Widget A', price: '100.00', description: 'First product', bullets: 'Solid', ...over });
}

describe('branding + multi-product store + subdomain routing', () => {
  it('lists every added product on the public store page, not just the last one', async () => {
    const { wid, H } = await setup();
    expect((await addProduct(wid, H, { productName: 'Alpha Gadget', price: '50.00' })).status).toBe(200);
    expect((await addProduct(wid, H, { productName: 'Beta Gizmo', price: '75.00' })).status).toBe(200);

    const res = await request(app).get(`/shop/${wid}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('Alpha Gadget');
    expect(res.text).toContain('Beta Gizmo');
    expect(res.text).toContain('50.00');
    expect(res.text).toContain('75.00');

    const products = await db.Product.count({ where: { workspaceId: wid, status: 'active' } });
    expect(products).toBe(2);
  });

  it('a branding update is reflected on the public store page', async () => {
    const { wid, H } = await setup('Plain Name');
    await addProduct(wid, H);

    const upd = await request(app)
      .post(`/api/v1/workspaces/${wid}/quickstart/branding`)
      .set(H)
      .type('form')
      .send({ name: 'Ahmed Emporium', logoUrl: 'https://cdn.example.com/logo.png', tagline: 'Only the good stuff' })
      .redirects(0);
    expect(upd.status).toBe(303);

    const res = await request(app).get(`/shop/${wid}`);
    expect(res.text).toContain('Ahmed Emporium');
    expect(res.text).toContain('https://cdn.example.com/logo.png');
    expect(res.text).toContain('Only the good stuff');

    const ws = await db.Workspace.findByPk(wid);
    expect(ws.name).toBe('Ahmed Emporium');
    expect(ws.tagline).toBe('Only the good stuff');
  });

  it('renders a product detail page and checks out that specific product', async () => {
    const { wid, H } = await setup();
    await addProduct(wid, H, { productName: 'Alpha Gadget', price: '50.00', description: 'The alpha one', bullets: 'Feature X\nFeature Y' });
    await addProduct(wid, H, { productName: 'Beta Gizmo', price: '75.00', description: 'The beta one' });

    const beta = await db.Product.findOne({ where: { workspaceId: wid, name: 'Beta Gizmo' } });

    const detail = await request(app).get(`/shop/${wid}/products/${beta.id}`);
    expect(detail.status).toBe(200);
    expect(detail.text).toContain('Beta Gizmo');
    expect(detail.text).toContain('75.00');
    expect(detail.text).toContain('The beta one');
    expect(detail.text).toContain(`/shop/${wid}/checkout?productId=${beta.id}`);

    const placed = await request(app)
      .post(`/shop/${wid}/checkout`)
      .type('form')
      .send({ productId: beta.id, fullName: 'Buyer', phone: '01099887766', addressLine: '1 St', city: 'Cairo', country: 'EG' })
      .redirects(0);
    expect(placed.status).toBe(303);

    const orderId = placed.headers.location.split('/').pop();
    const order = await db.Order.findByPk(orderId, { include: [{ model: db.OrderItem, as: 'items' }] });
    expect(String(order.totalAmount)).toBe('7500'); // bought Beta (75.00), not Alpha
    expect(order.items[0].productNameSnapshot).toBe('Beta Gizmo');
  });

  it('a Host header matching <slug>.PLATFORM_ROOT_DOMAIN resolves to that workspace store', async () => {
    const { wid, H, workspace } = await setup('Sub Store');
    await addProduct(wid, H, { productName: 'Subdomain Widget', price: '42.00' });

    const host = `${workspace.slug}.${env.platformRootDomain}`;
    const res = await request(app).get('/').set('Host', host);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('Sub Store');
    expect(res.text).toContain('Subdomain Widget');

    // a path under the subdomain works too
    const co = await request(app).get('/checkout').set('Host', host);
    expect(co.status).toBe(200);
    expect(co.text).toMatch(/Checkout/);
  });

  it('an unrecognized Host header falls through unaffected', async () => {
    const { wid, H } = await setup('Untouched Co');
    await addProduct(wid, H);

    const health = await request(app).get('/health').set('Host', 'random.example.net');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');

    // The normal path-based store still works with a foreign Host.
    const shop = await request(app).get(`/shop/${wid}`).set('Host', 'random.example.net');
    expect(shop.status).toBe(200);
    expect(shop.text).toContain('Untouched Co');

    // The staff API is unaffected by a foreign Host.
    const ws = await request(app).get('/api/v1/workspaces').set(H).set('Host', 'random.example.net');
    expect(ws.status).toBe(200);
  });
});
