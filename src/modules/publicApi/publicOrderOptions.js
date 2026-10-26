'use strict';

const env = require('../../config/env');
const db = require('../../db/models');

/**
 * ORDER_PAYLOAD_OPTIONS_ENABLED: each order line in the public API and the
 * webhooks carries what the shopper picked with it, so a till or a kitchen
 * screen can make the right thing:
 *
 *   options         the menu options (catalog/menuOptions.js) as charged:
 *                   [{ groupId, group, choices: [{ choiceId, name, priceDelta,
 *                   externalCode }] }]. externalCode is the code the choice
 *                   has now (product_option_choices.external_code, migration
 *                   715): null when it has none or the choice was removed.
 *   customizations  the answers to the product's custom fields
 *                   (catalog/customFields.js): [{ fieldId, type, label
 *                   { ar, en }, value, priceDelta }]. A photo is only named
 *                   (`photo: true`, value null): it is on the order page.
 *
 * Off (the default): neither key is in the payload, as before. Money in
 * minor units, like the rest of the order.
 */

const on = () => env.publicApi.orderOptions === true;

const choiceIdsOf = (orders) => [
  ...new Set(
    orders.flatMap((o) => (o.items || []).flatMap((i) => (Array.isArray(i.optionsSnapshot) ? i.optionsSnapshot : []).flatMap((g) => (g.choices || []).map((c) => c.choiceId))))
  ),
].filter(Boolean);

/** The current external codes of the choices these orders' lines were sold with: choiceId → code. */
async function optionCodes(workspaceId, orders) {
  const ids = choiceIdsOf(orders);
  if (ids.length === 0) return new Map();
  const rows = await db.ProductOptionChoice.findAll({ where: { id: ids, workspaceId }, attributes: ['id', 'externalCode'] });
  return new Map(rows.map((r) => [r.id, r.externalCode || null]));
}

const money = (value) => (value === null || value === undefined ? null : Number(value));

function lineOptions(snapshot, codes) {
  if (!Array.isArray(snapshot) || snapshot.length === 0) return [];
  return snapshot.map((g) => ({
    groupId: g.groupId || null,
    group: g.groupName || null,
    choices: (g.choices || []).map((c) => ({
      choiceId: c.choiceId || null,
      name: c.name,
      priceDelta: money(c.priceDeltaAmount) || 0,
      externalCode: (c.choiceId && codes.get(c.choiceId)) || null,
    })),
  }));
}

function lineCustomizations(snapshot) {
  if (!Array.isArray(snapshot) || snapshot.length === 0) return [];
  return snapshot.map((entry) => {
    const photo = entry.type === 'image';
    return {
      fieldId: entry.fieldId,
      type: entry.type,
      label: { ar: (entry.label && entry.label.ar) || '', en: (entry.label && entry.label.en) || '' },
      // Never the upload's id: it means nothing outside Zimos.
      value: photo ? null : entry.value === undefined ? null : entry.value,
      ...(photo ? { photo: true } : {}),
      priceDelta: money(entry.priceDeltaAmount) || 0,
    };
  });
}

/** The extra keys of one serialized line (publicOrderSerializer.serializeItem). */
function itemExtras(item, codes) {
  return { options: lineOptions(item.optionsSnapshot, codes), customizations: lineCustomizations(item.customizations) };
}

/**
 * The orders as the public API and the webhooks show them. Every reader of an
 * order for an integration goes through here:
 *   ORDER_PAYLOAD_OPTIONS_ENABLED  the lines' options and custom-field answers
 *   PUBLIC_API_ACK_ENABLED         `pos`: the till's status (posStatus.js), or null
 * Both off: exactly the order as before.
 */
async function serializeOrders(workspaceId, orders) {
  const { serializeOrder } = require('./publicOrderSerializer');
  const codes = on() ? await optionCodes(workspaceId, orders) : null;
  const pos = env.publicApi.ack === true ? await require('./posStatus').statusesFor(workspaceId, orders.map((o) => o.id)) : null;
  return orders.map((o) => {
    const out = serializeOrder(o, codes ? { optionCodes: codes } : {});
    if (pos) out.pos = pos.get(o.id) || null;
    return out;
  });
}

module.exports = { serializeOrders, itemExtras, optionCodes, on };
