'use strict';

const Joi = require('joi');
const joiEmail = require('../../core/utils/joiEmail');
const { TEMPLATE_KINDS } = require('../templates/templateValidation');
const { TYPES: BLOCKLIST_TYPES } = require('../risk/platformBlocklistService');
const { STATUSES: TICKET_STATUSES, PRIORITIES: TICKET_PRIORITIES } = require('../support/supportService');
const { messageBody: ticketMessageBody } = require('../support/supportValidation');
const {
  DISCOUNT_TYPES: REFERRAL_DISCOUNT_TYPES,
  AUDIENCES: REFERRAL_AUDIENCES,
  GRANT_TYPES: REFERRAL_GRANT_TYPES,
  CODE_STATES: REFERRAL_CODE_STATES,
} = require('../referrals/referralCodeService');
const { CYCLES: REFERRAL_CYCLES, DISCOUNT_STEP_TYPES, COMMISSION_BASES, MAX_STEPS, MAX_COUNT } = require('../referrals/referralTerms');
const { LIST_STATUSES: COMMISSION_LIST_STATUSES } = require('../referrals/commissionService');
const { BILLING_CYCLES } = require('../billing/planPricing');
const { KINDS: SPECIAL_TERMS_KINDS } = require('../billing/specialTermsService');

const uuid = Joi.string().uuid();

// Matches the admin UI's own rule: lowercase segments joined by dots or
// underscores, e.g. "checkout.one_page_v2".
const FLAG_KEY = /^[a-z0-9]+([._][a-z0-9]+)*$/;
const PLAN_CODE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const planBody = Joi.object({
  name: Joi.string().trim().min(1).max(150).required(),
  code: Joi.string().trim().lowercase().pattern(PLAN_CODE).max(50).required().messages({
    'string.pattern.base': 'Use lowercase letters, numbers and hyphens (e.g. "growth-plus")',
  }),
  // Minor units (e.g. piastres), so an integer is the only valid shape.
  monthlyPrice: Joi.number().integer().min(0).required(),
  // Ignored: the annual price is always 10 × monthlyPrice. Still accepted so
  // a client that sends it is not refused.
  yearlyPrice: Joi.number().integer().min(0).optional(),
  currency: Joi.string().uppercase().length(3).optional(),
  // 0 = no free trial.
  trialDays: Joi.number().integer().min(0).max(90).required().messages({
    'number.max': 'A free trial can be at most 90 days',
    'number.min': 'Trial days cannot be negative',
  }),
  // null = unlimited.
  orderQuota: Joi.number().integer().min(0).allow(null).default(null),
  transactionFeeBp: Joi.number().integer().min(0).max(10000).default(0),
  codFeeBp: Joi.number().integer().min(0).max(10000).default(0),
  features: Joi.array().items(Joi.string().max(60)).default([]),
  active: Joi.boolean().default(true),
  // Limits and visibility (migration 126). Each is optional with no default:
  // left out, a plan being edited keeps what it has (a console from before
  // these fields saves plans without them) and a new plan gets the column
  // default. null = unlimited.
  maxStores: Joi.number().integer().min(1).max(100000).allow(null).optional().messages({
    'number.min': 'Max stores must be at least 1, or unlimited',
  }),
  maxFunnelsPerMonth: Joi.number().integer().min(0).max(100000).allow(null).optional().messages({
    'number.min': 'Max funnels per month cannot be negative',
  }),
  // Shown on the marketing site and offered at sign-up.
  isPublic: Joi.boolean().optional(),
  displayOrder: Joi.number().integer().min(0).max(10000).optional(),
  // The pay-per-order fee for one order, minor units (50 = EGP 0.50). Only on
  // a plan with no monthly price, in EGP (platformAdminService.savePlan).
  // Left out: kept as it is.
  perOrderFee: Joi.number().integer().min(0).max(100000).optional(),
  // Pay per order (migration 220): orders free before any fee, and how far
  // below zero the balance may go in minor units (null = the fixed overdraft
  // and the old refusal). Left out: kept as it is.
  walletFreeOrders: Joi.number().integer().min(0).max(100000).optional(),
  walletDebtLimit: Joi.number().integer().min(0).max(100000000).allow(null).optional(),
});

const flagBody = Joi.object({
  key: Joi.string().trim().max(120).pattern(FLAG_KEY).required().messages({
    'string.pattern.base': 'Use lowercase letters, numbers, dots and underscores (e.g. checkout.one_page_v2)',
  }),
  description: Joi.string().allow('').max(2000).default(''),
  enabled: Joi.boolean().default(false),
  rollout: Joi.number().integer().min(0).max(100).default(0),
  targetWorkspaceIds: Joi.array().items(uuid).default([]),
});

const announcementBody = Joi.object({
  title: Joi.string().trim().min(1).max(200).required(),
  body: Joi.string().trim().min(1).max(10000).required(),
  severity: Joi.string().valid('info', 'warning').default('info'),
  audience: Joi.string().valid('all', 'plan', 'workspace').required(),
  // Required by, and only allowed with, the matching audience — so an edit
  // that narrows the audience can't leave a stale target behind.
  planId: uuid.allow(null).when('audience', {
    is: 'plan',
    then: Joi.required().invalid(null),
    otherwise: Joi.valid(null).default(null),
  }),
  workspaceId: uuid.allow(null).when('audience', {
    is: 'workspace',
    then: Joi.required().invalid(null),
    otherwise: Joi.valid(null).default(null),
  }),
  startsAt: Joi.date().iso().optional(),
  endsAt: Joi.date().iso().allow(null).default(null),
  dismissible: Joi.boolean().default(true),
});

// A swatch in the gallery grid, so a hex colour and nothing else — the column
// holds 20 characters but anything the grid can't paint is no use to it. ""
// is how the editor clears the field; the service turns it into NULL, which
// is what makes the card fall back to the active version's globalStyles.
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// Every editable column, with no `required` and no defaults — the PATCH body
// is these keys as-is, and the POST body below adds what a create needs.
const templateFields = {
  name: Joi.string().trim().min(1).max(200),
  category: Joi.string().trim().max(100).allow(null, ''),
  thumbnailUrl: Joi.string().trim().uri().max(500).allow(null, ''),
  isPublished: Joi.boolean(),
  kind: Joi.string().valid(...TEMPLATE_KINDS),
  // Minor units, like every other money field in the API.
  priceAmount: Joi.number().integer().min(0),
  // Separate from priceAmount on purpose: a paid template can be given away
  // for a while without losing its list price.
  isFree: Joi.boolean(),
  primaryColor: Joi.string().trim().pattern(HEX_COLOR).allow(null, '').messages({
    'string.pattern.base': 'Use a hex colour such as #2563EB',
  }),
  tags: Joi.array().items(Joi.string().trim().min(1).max(60)).max(20),
  rtl: Joi.boolean(),
};

// Defaults spelled out to match the column defaults, so a minimal create
// returns a fully-populated row instead of one the console has to guess at.
const createTemplateBody = Joi.object({
  ...templateFields,
  name: templateFields.name.required(),
  category: templateFields.category.default(null),
  thumbnailUrl: templateFields.thumbnailUrl.default(null),
  isPublished: templateFields.isPublished.default(false),
  kind: templateFields.kind.default('store'),
  priceAmount: templateFields.priceAmount.default(0),
  isFree: templateFields.isFree.default(true),
  primaryColor: templateFields.primaryColor.default(null),
  tags: templateFields.tags.default([]),
  rtl: templateFields.rtl.default(true),
});

// Partial, unlike the plan/flag PATCHes above: the grid flips one switch at a
// time (publish, price), and a full-body schema would let a form that never
// loaded `tags` reset it to [] via the default.
const updateTemplateBody = Joi.object(templateFields).min(1);

// One page of a template version — the shape pagesService.createWebsite
// copies from. `builderData` is checked in depth by the page-tree validator
// in the service; here it only has to be an object.
const PAGE_TYPES = ['home', 'product', 'collection', 'static', 'blog_post', 'cart', 'custom'];
const templatePage = Joi.object({
  path: Joi.string().trim().min(1).max(200).required(),
  title: Joi.string().trim().max(200).allow('').optional(),
  pageType: Joi.string().valid(...PAGE_TYPES).optional(),
  builderData: Joi.object().unknown(true).optional(),
  seo: Joi.object().unknown(true).optional(),
});

const templateVersionIds = Joi.object({ templateId: uuid.required(), versionId: uuid.required() });

// --- Platform risk -----------------------------------------------------------

// The address a platform block is fingerprinted from — the same fields, and
// the same limits, as an order's shipping address (orderValidation).
const blockAddress = Joi.object({
  country: Joi.string().trim().length(2).uppercase().required(),
  province: Joi.string().trim().max(100).allow(null, '').optional(),
  city: Joi.string().trim().min(1).max(100).required(),
  addressLine: Joi.string().trim().min(1).max(500).required(),
});

// null = never expires. A past date is refused by the service (422), which
// can compare against its own clock.
const expiresAt = Joi.date().iso().allow(null);

const blockBody = Joi.object({
  type: Joi.string().valid(...BLOCKLIST_TYPES).required(),
  // The identifier: a phone or an email in `value`, an address in `address`.
  value: Joi.when('type', {
    switch: [
      { is: 'phone', then: Joi.string().trim().min(1).max(32).required() },
      { is: 'email', then: joiEmail().trim().max(255).required() },
    ],
    otherwise: Joi.forbidden(),
  }),
  address: Joi.when('type', { is: 'address', then: blockAddress.required(), otherwise: Joi.forbidden() }),
  reason: Joi.string().trim().min(1).max(300).required(),
  expiresAt: expiresAt.default(null),
  // Where the block was made from — recorded in the audit metadata only.
  source: Joi.string().valid('manual', 'signal').default('manual'),
});

// Platform roles are data, so any well-formed key passes here and the service
// looks it up in platform_roles.
const roleKey = Joi.string().pattern(/^[a-z][a-z0-9_]{1,63}$/);
const permissionList = Joi.array().items(Joi.string().trim().max(64)).max(64).unique();

// The discount fields have to agree with each other (a percentage has no
// currency, 'none' has no value, ...); referralCodeService checks that on
// the merged record, so a PATCH is judged against what it leaves behind.
const referralCodeFields = {
  label: Joi.string().trim().max(120).allow('', null),
  discountType: Joi.string().valid(...REFERRAL_DISCOUNT_TYPES),
  // Basis points for a percentage, minor units for a fixed amount.
  discountValue: Joi.number().integer().min(1).allow(null),
  discountCurrency: Joi.string().trim().uppercase().length(3).allow(null),
  // Overrides the platform default commission rate; null = the default.
  commissionRateBp: Joi.number().integer().min(0).max(10000).allow(null),
};
// The second kind (migration 725, REFERRAL_CODES_V2_ENABLED; refused with
// 409 REFERRAL_V2_DISABLED while it is off). The shape of a schedule is
// checked here, its rules (only the last step open-ended, ranges per type)
// by referrals/referralTerms.
const stepCount = Joi.number().integer().min(1).max(MAX_COUNT).allow(null).required();
const discountStep = Joi.object({
  count: stepCount,
  type: Joi.string().valid(...DISCOUNT_STEP_TYPES).required(),
  value: Joi.number().integer().min(1).max(1e12).required(),
  currency: Joi.string().trim().uppercase().length(3),
});
const commissionStep = Joi.object({ count: stepCount, rateBp: Joi.number().integer().min(0).max(10000).required() });
const commissionSteps = Joi.array().items(commissionStep).max(MAX_STEPS);
const cycleTerms = Joi.object({
  discount: Joi.array().items(discountStep).max(MAX_STEPS).default([]),
  commission: commissionSteps.default([]),
});
const codeTerms = Joi.object({ monthly: cycleTerms.required(), yearly: cycleTerms.required() });
const linkTerms = Joi.object({ monthly: commissionSteps.required(), yearly: commissionSteps.required() });
const referralCodeV2Fields = {
  audience: Joi.string().valid(...REFERRAL_AUDIENCES),
  startsAt: Joi.date().iso().allow(null),
  endsAt: Joi.date().iso().allow(null),
  maxUses: Joi.number().integer().min(1).max(1000000).allow(null),
  allowedPlanIds: Joi.array().items(uuid).max(50).allow(null),
  allowedCycles: Joi.array().items(Joi.string().valid(...REFERRAL_CYCLES)).max(2).allow(null),
  minPriceAmount: Joi.number().integer().min(0).max(1e12).allow(null),
  minPriceCurrency: Joi.string().trim().uppercase().length(3).allow(null),
  terms: codeTerms.allow(null),
  commissionBasis: Joi.string().valid(...COMMISSION_BASES),
  linksAgent: Joi.boolean(),
  grantType: Joi.string().valid(...REFERRAL_GRANT_TYPES).allow(null),
  grantValue: Joi.number().integer().min(1).allow(null),
};
const referralCodeBody = Joi.object({
  code: Joi.string().trim().min(3).max(32).required(),
  ...referralCodeFields,
  ...referralCodeV2Fields,
  discountType: referralCodeFields.discountType.default('none'),
});

// --- Manual subscriptions and feature overrides (phase: billing/manual*) ---
const manualNote = Joi.string().trim().min(3).max(1000).required();
const manualDuration = Joi.object({
  months: Joi.number().integer().min(1).max(60),
  days: Joi.number().integer().min(1).max(1826),
}).xor('months', 'days');
const workspaceIdParams = Joi.object({ workspaceId: uuid.required() });
const overrideParams = Joi.object({ workspaceId: uuid.required(), overrideId: uuid.required() });

const manualSubscriptionSchemas = {
  activateSubscription: {
    params: workspaceIdParams,
    body: Joi.object({
      planId: uuid.required(),
      startsAt: Joi.date().iso().optional(),
      duration: manualDuration.optional(),
      endsAt: Joi.date().iso().optional(),
      billingCycle: Joi.string().valid('monthly', 'yearly').optional(),
      // billing/manualPricing: paid (default), free (a gift) or discounted by a
      // percent or to a price per period (minor units). Checked against the plan there.
      pricingKind: Joi.string().valid('paid', 'free', 'discounted').default('paid'),
      discountPercent: Joi.number().integer().min(1).max(99).allow(null).optional(),
      priceOverrideAmount: Joi.number().integer().min(1).allow(null).optional(),
      note: manualNote,
    }).xor('duration', 'endsAt'),
  },
  changeSubscriptionPlan: { params: workspaceIdParams, body: Joi.object({ planId: uuid.required(), note: manualNote }) },
  extendSubscription: { params: workspaceIdParams, body: Joi.object({ duration: manualDuration.required(), note: manualNote }) },
  endSubscription: { params: workspaceIdParams, body: Joi.object({ note: manualNote }) },
  addFeatureOverride: {
    params: workspaceIdParams,
    body: Joi.object({
      // Checked against billing/featureCatalog by the service (422 when unknown).
      featureKey: Joi.string().trim().max(60).required(),
      mode: Joi.string().valid('grant', 'deny').required(),
      value: Joi.any().allow(null).optional(),
      expiresAt: Joi.date().iso().allow(null).optional(),
      reason: manualNote,
    }),
  },
  updateFeatureOverride: {
    params: overrideParams,
    body: Joi.object({
      mode: Joi.string().valid('grant', 'deny').optional(),
      value: Joi.any().allow(null).optional(),
      expiresAt: Joi.date().iso().allow(null).optional(),
      reason: Joi.string().trim().min(3).max(1000).optional(),
    }).min(1),
  },
  revokeFeatureOverride: {
    params: overrideParams,
    body: Joi.object({ reason: Joi.string().trim().max(1000).allow('', null).optional() }),
  },
};

module.exports = {
  ...manualSubscriptionSchemas,

  // One search box: name, username, email, id (whole or 8+ first characters),
  // or a store's name / slug / subdomain / id. Empty lists everyone.
  searchUsers: {
    query: Joi.object({
      q: Joi.string().trim().max(200).allow('').default(''),
      page: Joi.number().integer().min(1).max(10000).default(1),
      limit: Joi.number().integer().min(1).max(50).default(25),
      // Deleted accounts are hidden from the list unless asked for.
      includeDeleted: Joi.boolean().default(false),
    }),
  },
  userParams: { params: Joi.object({ userId: uuid.required() }) },
  // The console asks before each of these; the API wants the same yes.
  suspendUser: {
    params: Joi.object({ userId: uuid.required() }),
    body: Joi.object({ reason: Joi.string().trim().min(2).max(500).required(), confirm: Joi.boolean().valid(true).required() }),
  },
  unsuspendUser: {
    params: Joi.object({ userId: uuid.required() }),
    body: Joi.object({ reason: Joi.string().trim().max(500).allow('', null).optional(), confirm: Joi.boolean().valid(true).required() }),
  },
  deleteUser: {
    params: Joi.object({ userId: uuid.required() }),
    body: Joi.object({
      reason: Joi.string().trim().max(500).allow('', null).optional(),
      // Required (as 'suspend') when the account owns stores.
      stores: Joi.string().valid('suspend').optional(),
      confirm: Joi.boolean().valid(true).required(),
    }),
  },

  createPlan: { body: planBody },
  updatePlan: { params: Joi.object({ planId: uuid.required() }), body: planBody },
  deletePlan: { params: Joi.object({ planId: uuid.required() }) },

  listSubscriptions: {
    query: Joi.object({
      status: Joi.string().valid('trialing', 'active', 'past_due', 'suspended', 'cancelled', 'draft').optional(),
    }),
  },

  // Every filter is optional: the unfiltered call is the common one (the log
  // landing page). Joi coerces page/pageSize to numbers and from/to to Dates,
  // and `validate` writes the defaults back onto req.query.
  listAuditLog: {
    query: Joi.object({
      workspaceId: uuid.optional(),
      actorUserId: uuid.optional(),
      action: Joi.string().trim().max(100).optional(),
      entityType: Joi.string().trim().max(100).optional(),
      entityId: Joi.string().trim().max(100).optional(),
      from: Joi.date().iso().optional(),
      to: Joi.date().iso().min(Joi.ref('from')).optional(),
      // limit/offset, not page/pageSize — these are the names the admin UI
      // already sends. Capped so a client cannot ask for the whole table.
      limit: Joi.number().integer().min(1).max(200).default(50),
      offset: Joi.number().integer().min(0).default(0),
    }),
  },

  createFlag: { body: flagBody },
  updateFlag: { params: Joi.object({ flagId: uuid.required() }), body: flagBody },
  deleteFlag: { params: Joi.object({ flagId: uuid.required() }) },

  createAnnouncement: { body: announcementBody },
  updateAnnouncement: {
    params: Joi.object({ announcementId: uuid.required() }),
    body: announcementBody,
  },
  deleteAnnouncement: { params: Joi.object({ announcementId: uuid.required() }) },

  // Same optional `kind` tab as the public gallery; unlike it, this list shows
  // drafts and templates with no version at all.
  listTemplates: { query: Joi.object({ kind: Joi.string().valid(...TEMPLATE_KINDS).optional() }) },
  createTemplate: { body: createTemplateBody },
  updateTemplate: {
    params: Joi.object({ templateId: uuid.required() }),
    body: updateTemplateBody,
  },
  deleteTemplate: { params: Joi.object({ templateId: uuid.required() }) },
  templateParams: { params: Joi.object({ templateId: uuid.required() }) },
  createTemplateVersion: {
    params: Joi.object({ templateId: uuid.required() }),
    body: Joi.object({
      globalStyles: Joi.object().unknown(true).default({}),
      pages: Joi.array().items(templatePage).min(1).max(50).required(),
      sections: Joi.array().items(Joi.object().unknown(true)).max(200).default([]),
      // Make it the version the gallery offers (the highest active one).
      activate: Joi.boolean().default(true),
    }),
  },
  templateVersionParams: { params: templateVersionIds },
  updateTemplateVersion: { params: templateVersionIds, body: Joi.object({ isActive: Joi.boolean().required() }) },

  listBlocklist: {
    query: Joi.object({
      type: Joi.string().valid(...BLOCKLIST_TYPES).optional(),
      status: Joi.string().valid('active', 'expired', 'all').default('all'),
      q: Joi.string().trim().min(1).max(200).optional(),
      limit: Joi.number().integer().min(1).max(200).default(50),
      offset: Joi.number().integer().min(0).default(0),
    }),
  },
  createBlocklistEntry: { body: blockBody },
  // The identifier is fixed once blocked — delete and re-block to change it.
  updateBlocklistEntry: {
    params: Joi.object({ entryId: uuid.required() }),
    body: Joi.object({
      reason: Joi.string().trim().min(1).max(300),
      expiresAt,
    }).min(1),
  },
  deleteBlocklistEntry: { params: Joi.object({ entryId: uuid.required() }) },

  // An adapter code: lower-case letters, digits, '-' and '_' (adapterContract).
  providerCode: { params: Joi.object({ code: Joi.string().pattern(/^[a-z0-9_-]{1,50}$/).required() }) },

  listTickets: {
    query: Joi.object({
      status: Joi.string().valid(...TICKET_STATUSES).optional(),
      priority: Joi.string().valid(...TICKET_PRIORITIES).optional(),
      workspaceId: uuid.optional(),
      q: Joi.string().trim().min(1).max(200).optional(),
      limit: Joi.number().integer().min(1).max(200).default(50),
      offset: Joi.number().integer().min(0).default(0),
    }),
  },
  ticketParams: { params: Joi.object({ ticketId: uuid.required() }) },
  replyTicket: {
    params: Joi.object({ ticketId: uuid.required() }),
    body: Joi.object({
      body: ticketMessageBody.required(),
      // Where the ticket goes after the reply; default pending (waiting on
      // the merchant). Replying cannot close a ticket — close it explicitly.
      status: Joi.string().valid('open', 'pending', 'resolved').optional(),
    }),
  },
  updateTicket: {
    params: Joi.object({ ticketId: uuid.required() }),
    body: Joi.object({
      status: Joi.string().valid(...TICKET_STATUSES),
      priority: Joi.string().valid(...TICKET_PRIORITIES),
    }).min(1),
  },

  // `permissions` omitted = the role's default set. The keys themselves (and
  // who may grant which) are checked by adminUsersService.
  grantAdmin: {
    body: Joi.object({
      email: joiEmail().trim().max(255).required(),
      role: roleKey.required(),
      permissions: permissionList.optional(),
    }),
  },
  updateAdmin: {
    params: Joi.object({ userId: uuid.required() }),
    body: Joi.object({ role: roleKey, permissions: permissionList }).min(1),
  },
  revokeAdmin: { params: Joi.object({ userId: uuid.required() }) },

  createAgent: {
    body: Joi.object({
      email: joiEmail().trim().max(255).required(),
      // Offered in the same form so a new agent can start with a code.
      firstCode: referralCodeBody.optional(),
    }),
  },
  agentParams: { params: Joi.object({ agentId: uuid.required() }) },
  createReferralCode: { params: Joi.object({ agentId: uuid.required() }), body: referralCodeBody },
  // A code with or without an agent (Agents -> Referral codes).
  createStandaloneReferralCode: { body: referralCodeBody.keys({ agentId: uuid.allow(null).optional() }) },
  listReferralCodes: {
    query: Joi.object({
      q: Joi.string().trim().max(100).allow('').optional(),
      // 'none': the codes with no agent.
      agentId: Joi.alternatives().try(uuid, Joi.string().valid('none')).optional(),
      state: Joi.string().valid(...REFERRAL_CODE_STATES).optional(),
      audience: Joi.string().valid(...REFERRAL_AUDIENCES).optional(),
      limit: Joi.number().integer().min(1).max(200).default(50),
      offset: Joi.number().integer().min(0).default(0),
    }),
  },
  referralCodeParams: { params: Joi.object({ codeId: uuid.required() }) },
  listCodeRedemptions: {
    params: Joi.object({ codeId: uuid.required() }),
    query: Joi.object({
      q: Joi.string().trim().max(100).allow('').optional(),
      status: Joi.string().valid('current', 'ended').optional(),
      merchantKind: Joi.string().valid('new', 'existing').optional(),
      source: Joi.string().valid('signup', 'plan_page', 'plan_switch', 'legacy').optional(),
      limit: Joi.number().integer().min(1).max(200).default(50),
      offset: Joi.number().integer().min(0).default(0),
    }),
  },
  // The simulator: unsaved form values, nothing written.
  simulateReferralCode: {
    body: Joi.object({
      planId: uuid.required(),
      billingCycle: Joi.string().valid(...REFERRAL_CYCLES).required(),
      terms: codeTerms.required(),
      commissionBasis: Joi.string().valid(...COMMISSION_BASES).default('paid'),
      hasAgent: Joi.boolean().default(true),
      payments: Joi.number().integer().min(1).max(60).default(12),
    }),
  },
  workspaceReferrals: { params: Joi.object({ workspaceId: uuid.required() }) },
  userReferrals: { params: Joi.object({ userId: uuid.required() }) },
  // Linking a store to an agent by hand; an open link is ended ('replaced').
  createAgentLink: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      agentId: uuid.required(),
      startsAt: Joi.date().iso().optional(),
      endsAt: Joi.date().iso().allow(null).optional(),
      terms: linkTerms.required(),
      commissionBasis: Joi.string().valid(...COMMISSION_BASES).default('paid'),
      note: Joi.string().trim().max(1000).allow('', null).optional(),
    }),
  },
  updateAgentLink: {
    params: Joi.object({ linkId: uuid.required() }),
    body: Joi.object({
      endsAt: Joi.date().iso().allow(null),
      terms: linkTerms,
      commissionBasis: Joi.string().valid(...COMMISSION_BASES),
      note: Joi.string().trim().max(1000).allow('', null),
    }).min(1),
  },
  endAgentLink: {
    params: Joi.object({ linkId: uuid.required() }),
    body: Joi.object({ note: Joi.string().trim().max(1000).allow('', null).optional() }),
  },
  // The code string is fixed once created (merchants and print use it).
  updateReferralCode: {
    params: Joi.object({ codeId: uuid.required() }),
    body: Joi.object({
      label: referralCodeFields.label,
      discountType: referralCodeFields.discountType,
      discountValue: referralCodeFields.discountValue,
      discountCurrency: referralCodeFields.discountCurrency,
      commissionRateBp: referralCodeFields.commissionRateBp,
      active: Joi.boolean(),
      ...referralCodeV2Fields,
      // Giving a code an agent, another one, or none (null).
      agentId: uuid.allow(null),
    }).min(1),
  },
  listCommissions: {
    query: Joi.object({
      agentId: uuid.optional(),
      codeId: uuid.optional(),
      workspaceId: uuid.optional(),
      status: Joi.string().valid(...COMMISSION_LIST_STATUSES).optional(),
      limit: Joi.number().integer().min(1).max(200).default(50),
      offset: Joi.number().integer().min(0).default(0),
    }),
  },
  // No agentId: an agent's own list is always theirs.
  listMyCommissions: {
    query: Joi.object({
      codeId: uuid.optional(),
      status: Joi.string().valid(...COMMISSION_LIST_STATUSES).optional(),
      limit: Joi.number().integer().min(1).max(200).default(50),
      offset: Joi.number().integer().min(0).default(0),
    }),
  },
  workspaceParams: { params: Joi.object({ workspaceId: uuid.required() }) },
  // `amountReceived` is what actually arrived, in the charge's minor units;
  // it may differ from the amount due, and the commission is worked out on it.
  recordPayment: {
    params: Joi.object({ chargeId: uuid.required() }),
    body: Joi.object({
      amountReceived: Joi.number().integer().min(0).max(Number.MAX_SAFE_INTEGER).required(),
      note: Joi.string().trim().max(1000).allow('', null).optional(),
      // When the money arrived; blank means now. A payment recorded late is
      // dated in the past — never in the future.
      paidAt: Joi.date().iso().max('now').allow('', null).optional(),
    }),
  },
  setBillingCycle: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({ billingCycle: Joi.string().valid(...BILLING_CYCLES).required() }),
  },
  // A note is required on every grant: what was agreed and why.
  grantSpecialTerms: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({
      kind: Joi.string().valid(...SPECIAL_TERMS_KINDS).required(),
      note: Joi.string().trim().min(1).max(2000).required(),
      months: Joi.when('kind', {
        is: 'free_months',
        then: Joi.number().integer().min(1).max(36).required(),
        otherwise: Joi.forbidden(),
      }),
      // Minor units of the plan's currency.
      priceAmount: Joi.when('kind', {
        is: 'price_override',
        then: Joi.number().integer().min(0).max(Number.MAX_SAFE_INTEGER).required(),
        otherwise: Joi.forbidden(),
      }),
      charges: Joi.when('kind', {
        is: 'price_override',
        then: Joi.number().integer().min(1).max(36).required(),
        otherwise: Joi.forbidden(),
      }),
    }),
  },
  // A reason is required both ways; it goes to the audit log.
  suspendWorkspace: {
    params: Joi.object({ workspaceId: uuid.required() }),
    body: Joi.object({ reason: Joi.string().trim().min(1).max(2000).required() }),
  },
  reversePayment: {
    params: Joi.object({ chargeId: uuid.required() }),
    body: Joi.object({ reason: Joi.string().trim().max(1000).allow('', null).optional() }),
  },
  // A reason is required: it is kept on the charge (void_note) and in the audit log.
  voidCharge: {
    params: Joi.object({ chargeId: uuid.required() }),
    body: Joi.object({ reason: Joi.string().trim().min(1).max(500).required() }),
  },
  markCommissionPaid: {
    params: Joi.object({ commissionId: uuid.required() }),
    body: Joi.object({ note: Joi.string().trim().max(1000).allow('', null).optional() }),
  },

  listRiskSignals: {
    query: Joi.object({
      type: Joi.string().valid(...BLOCKLIST_TYPES).default('phone'),
      windowDays: Joi.number().integer().min(1).max(365).default(90),
      minWorkspaces: Joi.number().integer().min(2).max(100).default(3),
      minRefused: Joi.number().integer().min(1).max(1000).default(3),
      limit: Joi.number().integer().min(1).max(200).default(50),
      offset: Joi.number().integer().min(0).default(0),
    }),
  },
};
