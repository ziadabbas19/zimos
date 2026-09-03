'use strict';

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');

async function setup() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Quick Co');
  return { auth, workspace, wid: workspace.id, H: { Authorization: `Bearer ${auth.accessToken}` } };
}

const FORM = {
  template: 'light',
  productName: 'Wonder Widget',
  price: '199.00',
  imageUrl: 'https://example.com/w.jpg',
  description: 'The best widget around.',
  bullets: 'Durable\nLightweight\nUSB-C',
};

async function provision(wid, H, overrides = {}) {
  return request(app)
    .post(`/api/v1/workspaces/${wid}/quickstart`)
    .set(H)
    .type('form')
    .send({ ...FORM, ...overrides });
}

describe('quickstart server-rendered storefront', () => {
  it('renders an HTML setup form for the merchant', async () => {
    const { wid, H } = await setup();
    const res = await request(app).get(`/api/v1/workspaces/${wid}/quickstart`).set(H);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toMatch(/Quick store setup/);
    expect(res.text).toMatch(/name="productName"/);
  });

  it('provisions a website + published "/" page + purchasable variant through the existing services', async () => {
    const { wid, H } = await setup();
    const res = await provision(wid, H);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/live/i);

    const website = await db.Website.findOne({ where: { workspaceId: wid } });
    expect(website).not.toBeNull();
    expect(website.status).toBe('published');

    const page = await db.WebsitePage.findOne({ where: { workspaceId: wid, path: '/' } });
    expect(page.publishedData).not.toBeNull(); // went through the real publish path
    expect(page.seo._store).toBeDefined();
    const els = page.draftData.sections[0].rows[0].columns[0].elements;
    expect(els.some((e) => e.type === 'product_list')).toBe(true);

    const product = await db.Product.findOne({ where: { workspaceId: wid } });
    expect(product.name).toBe('Wonder Widget');

    const variant = await db.ProductVariant.findOne({ where: { workspaceId: wid } });
    expect(String(variant.priceAmount)).toBe('19900');
    expect(variant.allowOverselling).toBe(true);
  });

  it('serves the product info as HTML at the public /shop URL', async () => {
    const { wid, H } = await setup();
    await provision(wid, H);
    const res = await request(app).get(`/shop/${wid}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('Wonder Widget');
    expect(res.text).toContain('199.00');
    expect(res.text).toContain('The best widget around.');
  });

  it('content-negotiates the public page endpoint: HTML on ?format=html, JSON otherwise', async () => {
    const { wid, H } = await setup();
    await provision(wid, H);

    const html = await request(app).get(`/api/v1/store/${wid}/pages/?format=html`);
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toMatch(/html/);
    expect(html.text).toContain('Wonder Widget');

    const json = await request(app).get(`/api/v1/store/${wid}/pages/`);
    expect(json.status).toBe(200);
    expect(json.headers['content-type']).toMatch(/json/);
    expect(json.body.page.tree.sections).toBeDefined();
  });

  it('takes a real order end to end: view -> checkout form -> order created -> thank-you page', async () => {
    const { wid, H } = await setup();
    await provision(wid, H);

    const checkoutForm = await request(app).get(`/shop/${wid}/checkout`);
    expect(checkoutForm.status).toBe(200);
    expect(checkoutForm.text).toMatch(/Checkout/);
    expect(checkoutForm.text).toMatch(/name="phone"/);

    const placed = await request(app)
      .post(`/shop/${wid}/checkout`)
      .type('form')
      .send({ fullName: 'Buyer One', phone: '01099887766', addressLine: '1 Main St', city: 'Cairo', country: 'EG' })
      .redirects(0);
    expect(placed.status).toBe(303);
    expect(placed.headers.location).toMatch(new RegExp(`^/shop/${wid}/thanks/`));

    const orderId = placed.headers.location.split('/').pop();
    const order = await db.Order.findByPk(orderId);
    expect(order).not.toBeNull();
    expect(order.workspaceId).toBe(wid);
    expect(String(order.totalAmount)).toBe('19900');

    const ty = await request(app).get(placed.headers.location);
    expect(ty.status).toBe(200);
    expect(ty.text).toContain(order.orderNumber);
  });

  it('rejects a nonsense price with a re-rendered form, not a crash', async () => {
    const { wid, H } = await setup();
    const res = await provision(wid, H, { price: 'free!' });
    expect(res.status).toBe(422);
    expect(res.text).toMatch(/valid price/i);
  });

  it('accepts the access token from the query string / form field (no Authorization header)', async () => {
    const { wid, auth } = await setup();

    // GET the form with ?token= and no Authorization header (browser flow).
    const formRes = await request(app).get(`/api/v1/workspaces/${wid}/quickstart?token=${auth.accessToken}`);
    expect(formRes.status).toBe(200);
    expect(formRes.text).toMatch(/Quick store setup/);

    // POST provision with the token as a hidden form field, still no header.
    const submitRes = await request(app)
      .post(`/api/v1/workspaces/${wid}/quickstart`)
      .type('form')
      .send({ ...FORM, token: auth.accessToken });
    expect(submitRes.status).toBe(200);
    expect(submitRes.text).toMatch(/live/i);

    const shop = await request(app).get(`/shop/${wid}`);
    expect(shop.status).toBe(200);
    expect(shop.text).toContain('Wonder Widget');
  });

  it('still rejects the quickstart route with no token anywhere', async () => {
    const { wid } = await setup();
    const res = await request(app).get(`/api/v1/workspaces/${wid}/quickstart`);
    expect(res.status).toBe(401);
  });
});
