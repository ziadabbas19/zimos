'use strict';

const Joi = require('joi');
const db = require('../../db/models');
const { AppError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');

/*
 * Menu options: a product's option groups ("Size", "Extras") with choices,
 * each choice adding its price to the unit price (migration 218). For
 * restaurants, cafés and bakeries; a product with no groups sells exactly
 * as before.
 *
 * The shopper sends only which choices they picked — [{ groupId, choiceIds }]
 * — on a cart line, a Buy Now item or a funnel checkout item. The server
 * checks them against the product's active groups and choices, in this
 * store, every time (cart add and order): an unknown or inactive group or
 * choice is refused, so is more than a group's maximum, and — on the
 * shopper's own orders — fewer than its minimum (a required group needs at
 * least one). Prices come from the database only.
 *
 * The order line keeps a snapshot (order_items.options_snapshot): group and
 * choice names and each choice's price as charged, so changing the menu
 * later never rewrites an order.
 */

const MAX_GROUPS = 20;
const MAX_CHOICES = 50;
const uuid = Joi.string().uuid();

/** What a shopper sends with a line. */
const optionsInputSchema = Joi.array()
  .items(Joi.object({ groupId: uuid.required(), choiceIds: Joi.array().items(uuid).max(MAX_CHOICES).unique().required() }))
  .max(MAX_GROUPS)
  .unique('groupId');

const invalid = (problem, message) => new AppError('OPTIONS_INVALID', message, 422, [{ field: 'options', ...problem }]);

const effectiveMin = (g) => Math.max(Number(g.minSelect) || 0, g.required ? 1 : 0);

/** A product's active groups with their active choices, in their order. */
async function activeGroups(workspaceId, productId, transaction) {
  const groups = await db.ProductOptionGroup.findAll({
    where: { workspaceId, productId, active: true },
    include: [{ model: db.ProductOptionChoice, as: 'choices', where: { active: true }, required: false }],
    order: [
      ['sortOrder', 'ASC'],
      ['createdAt', 'ASC'],
      [{ model: db.ProductOptionChoice, as: 'choices' }, 'sortOrder', 'ASC'],
    ],
    transaction,
  });
  return groups;
}

/**
 * Checks a line's picks and prices them. Returns { input, snapshot,
 * deltaPerUnit }: `input` normalized for comparing cart lines, `snapshot`
 * for the order line (null when nothing was picked), `deltaPerUnit` in minor
 * units. 422 OPTIONS_INVALID with what is wrong.
 */
async function resolveSelection(workspaceId, productId, rawInput, { enforceRequired = false, transaction } = {}) {
  const input = Array.isArray(rawInput) ? rawInput : [];
  const groups = await activeGroups(workspaceId, productId, transaction);
  if (groups.length === 0 && input.length === 0) return { input: null, snapshot: null, deltaPerUnit: 0 };

  const byGroup = new Map(groups.map((g) => [g.id, g]));
  const picked = new Map();
  for (const entry of input) {
    const group = byGroup.get(entry.groupId);
    if (!group) throw invalid({ code: 'UNKNOWN_GROUP', groupId: entry.groupId }, 'This option is not available for this product');
    const choices = new Map((group.choices || []).map((c) => [c.id, c]));
    for (const choiceId of entry.choiceIds || []) {
      if (!choices.has(choiceId)) throw invalid({ code: 'UNKNOWN_CHOICE', groupId: group.id, choiceId }, 'This choice is not available');
    }
    picked.set(group.id, new Set(entry.choiceIds || []));
  }

  const snapshot = [];
  const normalized = [];
  let delta = 0;
  for (const group of groups) {
    const ids = picked.get(group.id) || new Set();
    const max = Number(group.maxSelect) || 1;
    if (ids.size > max) {
      throw invalid({ code: 'TOO_MANY', groupId: group.id, max, groupName: group.name }, `Pick at most ${max} in "${group.name}"`);
    }
    const min = effectiveMin(group);
    if (enforceRequired && ids.size < min) {
      throw invalid({ code: group.required && ids.size === 0 ? 'REQUIRED' : 'TOO_FEW', groupId: group.id, min, groupName: group.name }, `Pick at least ${min} in "${group.name}"`);
    }
    if (ids.size === 0) continue;
    // In the menu's order, not the order they were sent in.
    const chosen = (group.choices || []).filter((c) => ids.has(c.id));
    snapshot.push({
      groupId: group.id,
      groupName: group.name,
      choices: chosen.map((c) => ({ choiceId: c.id, name: c.name, priceDeltaAmount: Number(c.priceDeltaAmount) })),
    });
    normalized.push({ groupId: group.id, choiceIds: chosen.map((c) => c.id) });
    delta += chosen.reduce((sum, c) => sum + Number(c.priceDeltaAmount), 0);
  }
  return { input: normalized.length ? normalized : null, snapshot: snapshot.length ? snapshot : null, deltaPerUnit: delta };
}

/** Whether two cart lines' picks are the same (normalized input or null). */
function sameSelection(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

/** "Size: Large · Extras: Cheese, Olives" for sheets, labels and messages. */
function optionsLabel(snapshot) {
  if (!Array.isArray(snapshot) || snapshot.length === 0) return '';
  return snapshot.map((g) => `${g.groupName}: ${(g.choices || []).map((c) => c.name).join(', ')}`).join(' · ');
}

/**
 * For the cart's display: the current names and prices of the picks stored
 * on its lines, by choice id ({ id → { name, priceDeltaAmount, groupId,
 * groupName } }); a choice switched off since is simply absent.
 */
async function choiceIndex(workspaceId, selections) {
  const ids = [...new Set(selections.flatMap((s) => (Array.isArray(s) ? s.flatMap((g) => g.choiceIds || []) : [])))];
  if (ids.length === 0) return new Map();
  const rows = await db.ProductOptionChoice.findAll({
    where: { id: ids, workspaceId, active: true },
    include: [{ model: db.ProductOptionGroup, as: 'group', attributes: ['id', 'name', 'active'] }],
  });
  return new Map(rows.filter((c) => c.group && c.group.active).map((c) => [c.id, { name: c.name, priceDeltaAmount: Number(c.priceDeltaAmount), groupId: c.groupId, groupName: c.group.name }]));
}

/** A cart line's picks priced now: { delta, snapshot } (see choiceIndex). */
function priceFromIndex(selection, index) {
  if (!Array.isArray(selection) || selection.length === 0) return { delta: 0, snapshot: null };
  const snapshot = [];
  let delta = 0;
  for (const g of selection) {
    const choices = (g.choiceIds || []).map((id) => index.get(id)).filter(Boolean);
    if (choices.length === 0) continue;
    delta += choices.reduce((sum, c) => sum + c.priceDeltaAmount, 0);
    snapshot.push({ groupId: g.groupId, groupName: choices[0].groupName, choices: choices.map((c) => ({ name: c.name, priceDeltaAmount: c.priceDeltaAmount })) });
  }
  return { delta, snapshot: snapshot.length ? snapshot : null };
}

// --- Managing a product's groups (dashboard) ---------------------------------

const viewGroup = (g) => ({
  id: g.id,
  name: g.name,
  required: g.required,
  minSelect: g.minSelect,
  maxSelect: g.maxSelect,
  active: g.active,
  choices: (g.choices || []).map((c) => ({ id: c.id, name: c.name, priceDeltaAmount: Number(c.priceDeltaAmount), active: c.active, externalCode: c.externalCode || null })),
});

const groupsBodySchema = Joi.object({
  groups: Joi.array()
    .items(
      Joi.object({
        id: uuid.optional(),
        name: Joi.string().trim().min(1).max(100).required(),
        required: Joi.boolean().default(false),
        minSelect: Joi.number().integer().min(0).max(MAX_CHOICES).default(0),
        maxSelect: Joi.number().integer().min(1).max(MAX_CHOICES).default(1),
        active: Joi.boolean().default(true),
        choices: Joi.array()
          .items(
            Joi.object({
              id: uuid.optional(),
              name: Joi.string().trim().min(1).max(100).required(),
              priceDeltaAmount: Joi.number().integer().min(0).max(100000000).default(0),
              active: Joi.boolean().default(true),
              // The choice's code in the merchant's till / kitchen system (migration 715). Left out: kept as it is.
              externalCode: Joi.string().trim().max(120).allow(null, '').optional(),
            })
          )
          .min(1)
          .max(MAX_CHOICES)
          .required(),
      }).custom((g, helpers) => (g.minSelect > g.maxSelect ? helpers.message('"minSelect" must not exceed "maxSelect"') : g))
    )
    .max(MAX_GROUPS)
    .required(),
});

async function findProduct(workspaceId, productId, transaction, lock) {
  const product = await db.Product.findOne({ where: { id: productId, workspaceId }, attributes: ['id', 'name'], transaction, ...(lock ? { lock } : {}) });
  if (!product) throw new NotFoundError('Product');
  return product;
}

async function listForProduct(workspaceId, productId) {
  await findProduct(workspaceId, productId);
  const groups = await db.ProductOptionGroup.findAll({
    where: { workspaceId, productId },
    include: [{ model: db.ProductOptionChoice, as: 'choices', required: false }],
    order: [
      ['sortOrder', 'ASC'],
      ['createdAt', 'ASC'],
      [{ model: db.ProductOptionChoice, as: 'choices' }, 'sortOrder', 'ASC'],
    ],
  });
  return groups.map(viewGroup);
}

/**
 * PUT: the product's whole menu, in order. Rows sent with an id of this
 * product keep it (cart lines keep pointing at them); rows left out are
 * deleted; an id that is not this product's is refused.
 */
async function replaceForProduct(workspaceId, productId, body, req) {
  return db.sequelize.transaction(async (transaction) => {
    // The product row is the lock: two saves of one menu run one after the other.
    await findProduct(workspaceId, productId, transaction, transaction.LOCK.UPDATE);
    const existing = await db.ProductOptionGroup.findAll({
      where: { workspaceId, productId },
      include: [{ model: db.ProductOptionChoice, as: 'choices', required: false }],
      transaction,
    });
    const before = existing.map(viewGroup);
    const groupsById = new Map(existing.map((g) => [g.id, g]));
    const keptGroups = new Set();
    for (const [gi, g] of body.groups.entries()) {
      if (g.id && !groupsById.has(g.id)) throw new AppError('OPTION_GROUP_NOT_FOUND', 'An option group is not this product’s', 422);
      const values = { name: g.name, required: g.required, minSelect: g.minSelect, maxSelect: g.maxSelect, active: g.active, sortOrder: gi };
      const group = g.id
        ? await groupsById.get(g.id).update(values, { transaction })
        : await db.ProductOptionGroup.create({ ...values, workspaceId, productId }, { transaction });
      keptGroups.add(group.id);
      const choicesById = new Map(((groupsById.get(group.id) || {}).choices || []).map((c) => [c.id, c]));
      const keptChoices = new Set();
      for (const [ci, c] of g.choices.entries()) {
        if (c.id && !choicesById.has(c.id)) throw new AppError('OPTION_CHOICE_NOT_FOUND', 'A choice is not this group’s', 422);
        const cv = { name: c.name, priceDeltaAmount: c.priceDeltaAmount, active: c.active, sortOrder: ci };
        // Only when sent: a client that does not know the field never clears it.
        if (c.externalCode !== undefined) cv.externalCode = c.externalCode || null;
        const choice = c.id
          ? await choicesById.get(c.id).update(cv, { transaction })
          : await db.ProductOptionChoice.create({ ...cv, workspaceId, groupId: group.id }, { transaction });
        keptChoices.add(choice.id);
      }
      const dropped = [...choicesById.keys()].filter((id) => !keptChoices.has(id));
      if (dropped.length) await db.ProductOptionChoice.destroy({ where: { id: dropped, workspaceId }, transaction });
    }
    const droppedGroups = [...groupsById.keys()].filter((id) => !keptGroups.has(id));
    if (droppedGroups.length) await db.ProductOptionGroup.destroy({ where: { id: droppedGroups, workspaceId }, transaction });

    const after = await db.ProductOptionGroup.findAll({
      where: { workspaceId, productId },
      include: [{ model: db.ProductOptionChoice, as: 'choices', required: false }],
      order: [
        ['sortOrder', 'ASC'],
        [{ model: db.ProductOptionChoice, as: 'choices' }, 'sortOrder', 'ASC'],
      ],
      transaction,
    });
    const view = after.map(viewGroup);
    await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'product.options_update', entityType: 'Product', entityId: productId, before: { groups: before }, after: { groups: view }, req, transaction });
    return view;
  });
}

/** The storefront's product page: active groups with active choices ([] when none). */
async function publicGroups(workspaceId, productId) {
  const groups = await activeGroups(workspaceId, productId);
  return groups
    .filter((g) => (g.choices || []).length > 0)
    .map((g) => ({
      id: g.id,
      name: g.name,
      required: g.required,
      minSelect: effectiveMin(g),
      maxSelect: g.maxSelect,
      choices: g.choices.map((c) => ({ id: c.id, name: c.name, priceDeltaAmount: Number(c.priceDeltaAmount) })),
    }));
}

module.exports = {
  optionsInputSchema,
  groupsBodySchema,
  resolveSelection,
  sameSelection,
  optionsLabel,
  choiceIndex,
  priceFromIndex,
  listForProduct,
  replaceForProduct,
  publicGroups,
};
