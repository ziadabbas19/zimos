'use strict';

// The link check is pure: everything that reaches the database is stubbed out,
// so this file loads no models.
jest.mock('../../src/db/models', () => ({}));
jest.mock('../../src/core/queue', () => ({}));
jest.mock('../../src/modules/inventory/inventoryService', () => ({}));
jest.mock('../../src/modules/catalog/catalogService', () => ({}));

const env = require('../../src/config/env');
const { shopifyJsonUrl } = require('../../src/modules/catalog/importExport/productTransfer');

// Importing a product from a Shopify link (catalog/importExport): this server
// fetches the address a merchant typed, so it is held to the same rule as a
// webhook URL before anything connects.
describe('shopifyJsonUrl', () => {
  let saved;
  beforeEach(() => {
    saved = env.webhooks.allowPrivateUrls;
    env.webhooks.allowPrivateUrls = false;
  });
  afterEach(() => {
    env.webhooks.allowPrivateUrls = saved;
  });

  const refusal = (link) => {
    try {
      shopifyJsonUrl(link);
    } catch (err) {
      return err;
    }
    return null;
  };

  it('turns a product page link into the address of its public JSON', () => {
    expect(shopifyJsonUrl('https://shop.example.com/products/blue-shirt')).toBe('https://shop.example.com/products/blue-shirt.json');
    expect(shopifyJsonUrl(' https://shop.example.com/collections/all/products/blue-shirt.json ')).toBe(
      'https://shop.example.com/products/blue-shirt.json'
    );
  });

  it.each([
    ['a loopback address', 'https://127.0.0.1/products/x'],
    ['a private address', 'https://10.0.0.5:8443/products/x'],
    ['the cloud metadata address', 'https://169.254.169.254/products/x'],
    ['an IPv6 loopback address', 'https://[::1]/products/x'],
    ['an IPv4 address written as IPv6', 'https://[::ffff:10.0.0.1]/products/x'],
    ['localhost', 'https://localhost/products/x'],
    ['an internal hostname', 'https://db.internal/products/x'],
    ['a single-label hostname', 'https://postgres/products/x'],
  ])('refuses %s with a 422 on the url field', (_name, link) => {
    const err = refusal(link);
    expect(err).not.toBeNull();
    expect(err.statusCode).toBe(422);
    expect(err.details[0].field).toBe('url');
  });

  it('still refuses what it refused before', () => {
    expect(refusal('http://shop.example.com/products/x').statusCode).toBe(422);
    expect(refusal('https://user:pw@shop.example.com/products/x').statusCode).toBe(422);
    expect(refusal('https://shop.example.com/pages/about').statusCode).toBe(422);
    expect(refusal('not a link').statusCode).toBe(422);
  });
});
