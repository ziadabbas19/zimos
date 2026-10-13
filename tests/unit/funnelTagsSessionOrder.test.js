'use strict';

// The tagging step with its storage stubbed out: this file loads no models.
const mockOrderFindOne = jest.fn();
const mockCustomerFindOne = jest.fn();
jest.mock('../../src/db/models', () => ({ Order: { findOne: mockOrderFindOne }, Customer: { findOne: mockCustomerFindOne } }));
jest.mock('../../src/modules/contacts/contactService', () => ({
  cleanTags: (tags) => [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))],
}));

const { tagFromOutcome } = require('../../src/modules/funnels/funnelTags');

const WORKSPACE = 'ws-1';
const transaction = { LOCK: { UPDATE: 'UPDATE' } };
const step = {
  builderData: {
    sections: [{ id: 's1', type: 'section', rows: [{ id: 'r1', type: 'row', columns: [{ id: 'c1', type: 'column', elements: [{ id: 'btn', type: 'button', props: { contactTags: ['interested'] } }] }] }] }],
  },
};
const press = (extra = {}) => ({ type: 'clicked_through', sourceElementId: 'btn', ...extra });

// Tags a funnel button puts on a customer (funnels/funnelTags): the customer is
// the one behind the order the session holds. The advance route is public, so
// an order id in the request names somebody else's customer.
describe('tagFromOutcome', () => {
  let customer;
  beforeEach(() => {
    customer = { tags: ['existing'], update: jest.fn().mockResolvedValue() };
    mockOrderFindOne.mockReset().mockResolvedValue({ customerId: 'customer-1' });
    mockCustomerFindOne.mockReset().mockResolvedValue(customer);
  });

  it('tags nobody when the session holds no order, whatever order id the request carries', async () => {
    const added = await tagFromOutcome(WORKSPACE, step, press({ orderId: 'someone-elses-order' }), { orderId: null }, transaction);
    expect(added).toEqual([]);
    expect(mockOrderFindOne).not.toHaveBeenCalled();
    expect(mockCustomerFindOne).not.toHaveBeenCalled();
    expect(customer.update).not.toHaveBeenCalled();
  });

  it("tags the session's own customer, not the one the request names", async () => {
    const added = await tagFromOutcome(WORKSPACE, step, press({ orderId: 'someone-elses-order' }), { orderId: 'session-order' }, transaction);
    expect(added).toEqual(['interested']);
    expect(mockOrderFindOne).toHaveBeenCalledTimes(1);
    expect(mockOrderFindOne.mock.calls[0][0].where).toEqual({ id: 'session-order', workspaceId: WORKSPACE });
    expect(customer.update).toHaveBeenCalledWith({ tags: ['existing', 'interested'] }, { transaction });
  });

  it('still tags the customer of a session that ordered, with no order id in the request', async () => {
    const added = await tagFromOutcome(WORKSPACE, step, press(), { orderId: 'session-order' }, transaction);
    expect(added).toEqual(['interested']);
  });
});
