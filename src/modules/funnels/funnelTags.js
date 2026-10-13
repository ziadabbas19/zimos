'use strict';

const db = require('../../db/models');

/**
 * Tags from pages (SPEC §18.4 [LF]): a funnel's buttons can tag the customer
 * who presses them — "interested-in-course" on an upsell's accept button,
 * "bought-kit" on the order form. The tags are an element's `contactTags`
 * prop in the funnel's published snapshot, never something the browser
 * sends: the browser only reports the outcome (and which button), as before.
 *
 *   clicked_through + sourceElementId   that element's tags
 *   completed_checkout                  the step's order forms (cod_form)
 *   accepted_offer / declined_offer     the step's accept buttons / decline links
 *
 * Only a customer the funnel knows is tagged — someone who has ordered in this
 * session; a button pressed before the order tags nobody. Contact forms keep
 * their own `tags` prop (contacts/formService.js).
 */

const OUTCOME_ELEMENTS = {
  completed_checkout: 'cod_form',
  accepted_offer: 'upsell_accept_button',
  declined_offer: 'upsell_decline_link',
};

function walk(node, visit, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, depth + 1);
    return;
  }
  if (typeof node.type === 'string' && node.id !== undefined) visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'props' && value && typeof value === 'object') walk(value, visit, depth + 1);
  }
}

const tagsOf = (props) => {
  const raw = props && props.contactTags;
  return Array.isArray(raw) ? raw : String(raw || '').split(',');
};

/** The tags this outcome puts on the customer, from the step's own elements. */
function outcomeTags(step, outcome) {
  const tags = [];
  const byOutcome = OUTCOME_ELEMENTS[outcome.type];
  walk(step && step.builderData, (node) => {
    const own = tagsOf(node.props);
    if (own.every((t) => !String(t).trim())) return;
    const pressed = outcome.sourceElementId && String(node.id) === String(outcome.sourceElementId);
    if (pressed || node.type === byOutcome) tags.push(...own);
  });
  return require('../contacts/contactService').cleanTags(tags);
}

/**
 * Adds the outcome's tags to the session's customer, in the advance's own
 * transaction. Returns the tags added (empty when none apply).
 *
 * The customer is the one behind the order this session holds, never an order
 * id read from the request: the route is public, and an id sent with a button
 * press would tag whoever that order belongs to.
 */
async function tagFromOutcome(workspaceId, step, outcome, session, transaction) {
  const tags = outcomeTags(step, outcome);
  const orderId = session.orderId;
  if (tags.length === 0 || !orderId) return [];
  const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, attributes: ['customerId'], transaction });
  if (!order || !order.customerId) return [];
  const customer = await db.Customer.findOne({ where: { id: order.customerId, workspaceId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!customer) return [];
  const before = customer.tags || [];
  const after = require('../contacts/contactService').cleanTags([...before, ...tags]);
  if (after.length === before.length) return [];
  await customer.update({ tags: after }, { transaction });
  return after.filter((t) => !before.includes(t));
}

module.exports = { outcomeTags, tagFromOutcome };
