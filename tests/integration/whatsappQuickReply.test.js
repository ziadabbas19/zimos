'use strict';

// A customer's answer to the order confirmation message on WhatsApp
// (whatsapp/quickReplyConfirmation.js): only an answer to that message counts.
// "Confirm order" confirms the order; "Cancel" cancels a cash-on-delivery order
// still waiting for its confirmation, and a cancel the order is past is passed
// to the team instead. The Graph API is mocked with global.fetch; under the
// suite a queued job runs at once (core/queue).

const crypto = require('crypto');
const { app, request, setupWorkspaceWithProduct, confirmCodOrder } = require('../helpers/factories');
const db = require('../../src/db/models');

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const TOKEN = 'EAAG-quick-reply-token-1234567890';
const APP_SECRET = 'meta-app-secret-for-tests';
const PHONE_ID = '1122334455';
const CUSTOMER = '201012312312';

const realFetch = global.fetch;
let sent;

beforeAll(() => {
  process.env.WHATSAPP_GRAPH_BASE = 'https://graph.test/v21.0';
});
afterAll(() => {
  global.fetch = realFetch;
  delete process.env.WHATSAPP_GRAPH_BASE;
});
beforeEach(() => {
  sent = [];
  global.fetch = jest.fn(async (url, opts = {}) => {
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if ((opts.headers && opts.headers.Authorization) !== `Bearer ${TOKEN}`) return json(401, { error: { message: 'Invalid OAuth access token', code: 190 } });
    if (String(url).includes('/messages')) {
      sent.push(JSON.parse(opts.body));
      return json(200, { messages: [{ id: `wamid.out.${sent.length}` }] });
    }
    return json(200, { display_phone_number: '+20 10 0000 1111', verified_name: 'Nile Store' });
  });
});

/** A connected store with one new cash-on-delivery order from the storefront. */
async function storeWithOrder() {
  const ctx = await setupWorkspaceWithProduct();
  await request(app)
    .put(`/api/v1/workspaces/${ctx.workspace.id}/whatsapp/integration`)
    .set(bearer(ctx.auth.accessToken))
    .send({ phoneNumberId: PHONE_ID, accessToken: TOKEN, appSecret: APP_SECRET })
    .expect(200);
  const res = await request(app)
    .post(`/api/v1/store/${ctx.workspace.id}/checkout`)
    .set('Idempotency-Key', `qr-${crypto.randomUUID()}`)
    .send({
      contact: { fullName: 'Mona Ali', phone: '01012312312' },
      shippingAddress: { country: 'EG', city: 'Alexandria', addressLine: '6 Test St' },
      paymentMethod: 'cod',
      item: { variantId: ctx.variant.id, quantity: 1 },
    });
  expect(res.status).toBe(201);
  return { ...ctx, orderId: res.body.order.id };
}

/** The confirmation message, sent from the order page; answers Meta's id for it. */
async function sendConfirmation(ctx) {
  const res = await request(app).post(`/api/v1/workspaces/${ctx.workspace.id}/orders/${ctx.orderId}/whatsapp-confirm`).set(bearer(ctx.auth.accessToken)).send({});
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ channel: 'whatsapp', template: 'order_confirmation' });
  const row = await db.WhatsappMessage.findByPk(res.body.messageId);
  return row.waMessageId;
}

/** Another message about the same order (as a shipping automation sends it). */
async function sendOther(ctx, name = 'order_shipped') {
  const message = await require('../../src/modules/whatsapp/whatsappService').sendMessage(ctx.workspace.id, {
    to: CUSTOMER,
    orderId: ctx.orderId,
    template: { name, language: 'ar', params: ['Mona'] },
  });
  return message.waMessageId;
}

function signed(workspaceId, payload) {
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
  return request(app).post(`/api/v1/webhooks/whatsapp/${workspaceId}`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', `sha256=${sig}`).send(raw);
}

const delivery = (message) => ({
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID }, contacts: [{ wa_id: CUSTOMER, profile: { name: 'Mona' } }], messages: [message] },
        },
      ],
    },
  ],
});

const at = () => String(Math.floor(Date.now() / 1000));
// A tap on one of the template's quick-reply buttons; Meta names the message it belongs to.
const tap = (label, contextId) => delivery({ from: CUSTOMER, id: `wamid.in.${crypto.randomUUID()}`, timestamp: at(), type: 'button', context: { from: '201000001111', id: contextId }, button: { payload: label, text: label } });
// Typed text, quoting a message when contextId is given.
const typed = (body, contextId) => delivery({ from: CUSTOMER, id: `wamid.in.${crypto.randomUUID()}`, timestamp: at(), type: 'text', text: { body }, ...(contextId ? { context: { from: '201000001111', id: contextId } } : {}) });

const orderOf = (ctx) => db.Order.findByPk(ctx.orderId);
const confirmedAttempts = (ctx) =>
  db.ConfirmationAttempt.findAll({ where: { outcome: 'confirmed' }, include: [{ model: db.ConfirmationTask, as: 'task', where: { orderId: ctx.orderId }, attributes: [] }] });
const teamNotes = (ctx) => db.MerchantNotification.findAll({ where: { workspaceId: ctx.workspace.id, type: 'automation' }, order: [['createdAt', 'ASC']] });

describe('WhatsApp quick reply: Confirm order', () => {
  it('confirms the order the confirmation message was about, through the WhatsApp channel', async () => {
    const ctx = await storeWithOrder();
    const wamid = await sendConfirmation(ctx);

    const res = await signed(ctx.workspace.id, tap('تأكيد الطلب', wamid));
    expect(res.status).toBe(200);

    const order = await orderOf(ctx);
    expect(order.confirmationState).toBe('confirmed');
    expect(order.cancelledAt).toBeNull();
    const attempts = await confirmedAttempts(ctx);
    expect(attempts.map((a) => a.channel)).toEqual(['whatsapp']);
  });

  it('confirms by a typed "موافق" only when it quotes the message', async () => {
    const ctx = await storeWithOrder();
    const wamid = await sendConfirmation(ctx);

    await signed(ctx.workspace.id, typed('موافق'));
    expect((await orderOf(ctx)).confirmationState).toBe('pending');

    await signed(ctx.workspace.id, typed('موافق', wamid));
    expect((await orderOf(ctx)).confirmationState).toBe('confirmed');
  });

  it('ignores a "yes" to any other message about the order: nothing confirmed, no one told', async () => {
    const ctx = await storeWithOrder();
    await sendConfirmation(ctx);
    const review = await sendOther(ctx, 'review_request');

    await signed(ctx.workspace.id, typed('نعم', review));
    await signed(ctx.workspace.id, tap('تأكيد الطلب', review));

    expect((await orderOf(ctx)).confirmationState).toBe('pending');
    expect(await confirmedAttempts(ctx)).toHaveLength(0);
    expect(await teamNotes(ctx)).toHaveLength(0);
  });

  it('a tap that names no message we know confirms only through a confirmation message', async () => {
    const ctx = await storeWithOrder();
    await sendOther(ctx, 'order_shipped');

    await signed(ctx.workspace.id, tap('تأكيد الطلب', 'wamid.unknown.c1'));
    expect((await orderOf(ctx)).confirmationState).toBe('pending');

    await sendConfirmation(ctx);
    await signed(ctx.workspace.id, tap('تأكيد الطلب', 'wamid.unknown.c2'));
    expect((await orderOf(ctx)).confirmationState).toBe('confirmed');
  });

  it('a second tap changes nothing and tells no one', async () => {
    const ctx = await storeWithOrder();
    const wamid = await sendConfirmation(ctx);
    await signed(ctx.workspace.id, tap('تأكيد الطلب', wamid));
    await signed(ctx.workspace.id, tap('تأكيد الطلب', wamid));
    expect(await confirmedAttempts(ctx)).toHaveLength(1);
    expect(await teamNotes(ctx)).toHaveLength(0);
  });
});

describe('WhatsApp quick reply: Cancel', () => {
  it('cancels a cash-on-delivery order still waiting for its confirmation', async () => {
    const ctx = await storeWithOrder();
    const wamid = await sendConfirmation(ctx);

    const res = await signed(ctx.workspace.id, tap('إلغاء', wamid));
    expect(res.status).toBe(200);

    const order = await orderOf(ctx);
    expect(order.cancelledAt).not.toBeNull();
    expect(order.cancellationReason).toBe('العميل ألغى الطلب بزر واتساب');
    expect(order.confirmationState).toBe('rejected');
  });

  it('does not cancel an order that is already confirmed: the team is told, once', async () => {
    const ctx = await storeWithOrder();
    const wamid = await sendConfirmation(ctx);
    await signed(ctx.workspace.id, tap('تأكيد الطلب', wamid));
    expect((await orderOf(ctx)).confirmationState).toBe('confirmed');

    await signed(ctx.workspace.id, tap('إلغاء', wamid));
    await signed(ctx.workspace.id, tap('إلغاء', wamid));

    const order = await orderOf(ctx);
    expect(order.cancelledAt).toBeNull();
    expect(order.confirmationState).toBe('confirmed');
    const notes = await teamNotes(ctx);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ link: `/orders/${ctx.orderId}`, dedupeKey: `waqr.cancel_refused:${ctx.orderId}` });
    expect(notes[0].body).toContain('بعد تأكيد الطلب');
  });

  it('does not cancel an order an agent confirmed by phone either', async () => {
    const ctx = await storeWithOrder();
    const wamid = await sendConfirmation(ctx);
    await confirmCodOrder(ctx.auth.accessToken, ctx.workspace.id, ctx.orderId);

    await signed(ctx.workspace.id, typed('لا', wamid));

    expect((await orderOf(ctx)).cancelledAt).toBeNull();
    expect(await teamNotes(ctx)).toHaveLength(1);
  });

  it('does not cancel an order that is no longer pending (postponed): the team is told', async () => {
    const ctx = await storeWithOrder();
    const wamid = await sendConfirmation(ctx);
    await db.Order.update({ confirmationState: 'postponed' }, { where: { id: ctx.orderId } });

    await signed(ctx.workspace.id, tap('إلغاء', wamid));

    const order = await orderOf(ctx);
    expect(order.cancelledAt).toBeNull();
    expect(order.confirmationState).toBe('postponed');
    const notes = await teamNotes(ctx);
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toContain('ليس طلب دفع عند الاستلام في انتظار التأكيد');
  });

  it('ignores a "no" to any other message about the order: nothing cancelled, no one told', async () => {
    const ctx = await storeWithOrder();
    await sendConfirmation(ctx);
    const shipped = await sendOther(ctx, 'order_shipped');

    await signed(ctx.workspace.id, typed('لا', shipped));
    await signed(ctx.workspace.id, tap('إلغاء', shipped));

    const order = await orderOf(ctx);
    expect(order.cancelledAt).toBeNull();
    expect(order.confirmationState).toBe('pending');
    expect(await teamNotes(ctx)).toHaveLength(0);
  });

  it('a tap that names no message we know cancels only through a confirmation message', async () => {
    const ctx = await storeWithOrder();
    await sendOther(ctx, 'order_shipped');

    // Only a shipping message about the order: the cancel finds nothing to answer.
    await signed(ctx.workspace.id, tap('إلغاء', 'wamid.unknown.1'));
    expect((await orderOf(ctx)).cancelledAt).toBeNull();

    // With the confirmation message sent, the same tap cancels the single open order.
    await sendConfirmation(ctx);
    await signed(ctx.workspace.id, tap('إلغاء', 'wamid.unknown.2'));
    expect((await orderOf(ctx)).cancelledAt).not.toBeNull();
  });

  it('cancelOrder refuses a tap that lost the race to a confirmation (onlyWhilePendingCod)', async () => {
    const ctx = await storeWithOrder();
    await confirmCodOrder(ctx.auth.accessToken, ctx.workspace.id, ctx.orderId);
    const { systemRequest } = require('../../src/modules/automations/automationSteps');
    const { cancelOrder } = require('../../src/modules/orders/orderService');
    const req = await systemRequest(ctx.workspace.id);
    await expect(cancelOrder(ctx.workspace.id, ctx.orderId, { reason: 'x', onlyWhilePendingCod: true }, req)).rejects.toMatchObject({ code: 'ORDER_NOT_PENDING', statusCode: 409 });
    expect((await orderOf(ctx)).cancelledAt).toBeNull();
  });
});
