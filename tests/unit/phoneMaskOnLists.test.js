'use strict';

// The controllers with their services stubbed out: this file loads no models.
jest.mock('../../src/modules/contacts/contactService', () => ({ listContacts: jest.fn(), previewSegment: jest.fn() }));
jest.mock('../../src/modules/contacts/formService', () => ({}));
jest.mock('../../src/modules/publicApi/publicOrderService', () => ({ listOrders: jest.fn() }));
jest.mock('../../src/modules/dashboard/searchService', () => ({ search: jest.fn() }));
jest.mock('../../src/modules/dashboard/setupGuideService', () => ({}));
jest.mock('../../src/modules/audit/auditService', () => ({ recordAudit: jest.fn() }));
jest.mock('../../src/core/middleware/authenticate', () => ({ authenticate: (req, res, next) => next() }));
jest.mock('../../src/core/middleware/tenantContext', () => ({ resolveTenant: (req, res, next) => next() }));

const contactService = require('../../src/modules/contacts/contactService');
const publicOrderService = require('../../src/modules/publicApi/publicOrderService');
const searchService = require('../../src/modules/dashboard/searchService');
const contactController = require('../../src/modules/contacts/contactController');
const publicOrderController = require('../../src/modules/publicApi/publicOrderController');
const dashboardRoutes = require('../../src/modules/dashboard/dashboardRoutes');

const REVEAL = 'customers.reveal_sensitive';
const reqAs = (...permissions) => ({
  tenant: { workspaceId: 'ws-1', hasPermission: (p) => permissions.includes(p) },
  query: {},
  body: { rules: [] },
  params: {},
});

/** Runs one handler and gives back what it answered. */
function answerOf(handler, req) {
  return new Promise((resolve, reject) => {
    handler(req, { json: resolve }, reject);
  });
}
const searchHandler = dashboardRoutes.stack.find((layer) => layer.route && layer.route.path === '/search').route.stack.slice(-1)[0].handle;

const CONTACT = { id: 'c-1', fullName: 'Mona Ali', phoneNormalized: '201012345665', phoneRaw: '01012345665', email: 'mona@example.com' };

// Lists of customers (SPEC §3.4-8): a caller without customers.reveal_sensitive
// gets masked phone numbers, in every list as in the orders list and the export.
describe('phones in lists are masked for callers who may not see them', () => {
  beforeEach(() => {
    contactService.listContacts.mockResolvedValue({ contacts: [{ ...CONTACT }], nextCursor: null, total: 1 });
    contactService.previewSegment.mockResolvedValue({ total: 1, consenting: 1, sample: [{ ...CONTACT }] });
    searchService.search.mockResolvedValue({ orders: [], products: [], customers: [{ id: 'c-1', fullName: 'Mona Ali', phone: '01012345665', totalOrders: 2 }], funnels: [] });
    publicOrderService.listOrders.mockResolvedValue({
      orders: [{ id: 'o-1', orderNumber: '1001', contact: { fullName: 'Mona Ali', phone: '01012345665', alternatePhone: '01112345678' } }],
      nextCursor: null,
    });
  });

  it('the contacts list', async () => {
    const masked = await answerOf(contactController.list, reqAs('customers.view'));
    expect(masked.contacts[0]).toMatchObject({ phoneNormalized: '201******665', phoneRaw: '010*****665', fullName: 'Mona Ali', email: 'mona@example.com' });
    expect(masked.total).toBe(1);

    const full = await answerOf(contactController.list, reqAs('customers.view', REVEAL));
    expect(full.contacts[0]).toMatchObject({ phoneNormalized: '201012345665', phoneRaw: '01012345665' });
  });

  it('the segment preview', async () => {
    const masked = await answerOf(contactController.previewSegment, reqAs('customers.view'));
    expect(masked.sample[0].phoneNormalized).toBe('201******665');
    expect(masked.sample[0].phoneRaw).toBe('010*****665');
    expect(masked.total).toBe(1);

    const full = await answerOf(contactController.previewSegment, reqAs(REVEAL));
    expect(full.sample[0].phoneRaw).toBe('01012345665');
  });

  it('the dashboard search', async () => {
    const masked = await answerOf(searchHandler, { ...reqAs('customers.view'), query: { q: '0101' } });
    expect(masked.customers[0]).toEqual({ id: 'c-1', fullName: 'Mona Ali', phone: '010*****665', totalOrders: 2 });

    const full = await answerOf(searchHandler, { ...reqAs(REVEAL), query: { q: '0101' } });
    expect(full.customers[0].phone).toBe('01012345665');
  });

  it('the public API order list', async () => {
    // A key answers for a permission only when its creator holds it and one of its scopes lists it.
    const masked = await answerOf(publicOrderController.list, reqAs('orders.view'));
    expect(masked.orders[0].contact).toEqual({ fullName: 'Mona Ali', phone: '010*****665', alternatePhone: '011*****678' });
    expect(masked.orders[0].orderNumber).toBe('1001');

    const full = await answerOf(publicOrderController.list, reqAs('orders.view', REVEAL));
    expect(full.orders[0].contact.phone).toBe('01012345665');
  });
});
