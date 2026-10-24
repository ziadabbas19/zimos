'use strict';

// The host routing with its storage stubbed out: this file loads no models.
const mockWorkspace = { findOne: jest.fn() };
const mockDomain = { findOne: jest.fn() };
jest.mock('../../src/db/models', () => ({ Workspace: mockWorkspace, Domain: mockDomain }));

const env = require('../../src/config/env');
const { hostResolver } = require('../../src/core/middleware/hostResolver');

/** Runs the middleware for one request; resolves with the request once it calls next(). */
function route(host, url = '/api/v1/store/ws-1/pages/home') {
  const req = { headers: { host }, url };
  const res = { removeHeader: jest.fn(), status: jest.fn().mockReturnThis(), render: jest.fn() };
  return new Promise((resolve, reject) => {
    hostResolver(req, res, (err) => (err ? reject(err) : resolve(req)));
  });
}

// The storefront server calls the API on Railway's private network
// (INTERNAL_API_BASE_URL), so its Host is `<service>.railway.internal:<PORT>`.
// That host is never a store's: no lookup is made for it, and the request
// goes on to the path-based routes as before.
describe('hostResolver and Railway private hosts', () => {
  beforeEach(() => {
    mockWorkspace.findOne.mockReset().mockResolvedValue(null);
    mockDomain.findOne.mockReset().mockResolvedValue(null);
  });

  it('makes no lookup for a host on the private network and leaves the path alone', async () => {
    for (const host of ['zimos.railway.internal:8080', 'zimos.railway.internal', 'ZIMOS.Railway.Internal:4000', 'zimos.railway.internal.']) {
      const req = await route(host);
      expect(req.url).toBe('/api/v1/store/ws-1/pages/home');
    }
    expect(mockDomain.findOne).not.toHaveBeenCalled();
    expect(mockWorkspace.findOne).not.toHaveBeenCalled();
  });

  it('still looks up any other unknown host, as before', async () => {
    const req = await route('shop.example.com');
    expect(req.url).toBe('/api/v1/store/ws-1/pages/home');
    expect(mockDomain.findOne).toHaveBeenCalledTimes(2);
  });

  it('still routes a verified custom domain to its store', async () => {
    mockDomain.findOne.mockResolvedValueOnce({ workspaceId: 'ws-9', status: 'verified', suspendedAt: null });
    const req = await route('shop.example.com', '/products');
    expect(req.url).toBe('/shop/ws-9/products');
  });

  it('only skips the private zone itself, not a look-alike host', async () => {
    await route('railway.internal.example.com');
    await route('notrailway.internal');
    expect(mockDomain.findOne).toHaveBeenCalledTimes(4);
  });

  it('still routes a store subdomain of the platform', async () => {
    mockWorkspace.findOne.mockResolvedValueOnce({ id: 'ws-3' });
    const req = await route(`shop.${String(env.platformRootDomain).toLowerCase()}`, '/');
    expect(req.url).toBe('/shop/ws-3');
  });
});
