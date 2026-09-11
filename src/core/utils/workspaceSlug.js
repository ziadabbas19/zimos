'use strict';

const Joi = require('joi');

/**
 * Workspace slug rules — one place, because the slug is the store's public
 * address: every workspace is reachable at `<slug>.${PLATFORM_ROOT_DOMAIN}`
 * (see core/middleware/hostResolver.js). A slug therefore has to be a legal
 * DNS label: lowercase letters, digits and hyphens, 3-63 characters, never
 * starting or ending with a hyphen.
 *
 * Two different strictness levels live here on purpose:
 *
 *  - `workspaceSlug()` / `slugRejectionReason()` police a slug a merchant
 *    *chooses* (check-slug, PATCH). Strict, including the reserved list.
 *  - `workspaceRef()` polices a slug used to *look one up* in a public
 *    storefront path. Deliberately laxer: slugs auto-generated before these
 *    rules existed can be longer than 63 characters, and an existing store
 *    must keep resolving. An unknown slug 404s at the lookup either way.
 */

const SLUG_MIN = 3;
const SLUG_MAX = 63; // the longest a single DNS label may be

// Column width of workspaces.slug — the ceiling for a *lookup*, so a legacy
// slug longer than SLUG_MAX still resolves instead of 422-ing.
const SLUG_LOOKUP_MAX = 200;

// Shape only. Length is checked separately so a too-short slug can be
// reported as such rather than as "bad characters".
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Labels the platform may need to serve itself. A merchant holding one of
 * these would shadow that host the day we bring it up, and taking a slug
 * back afterwards breaks every link to their store — so they are refused
 * up front rather than reclaimed later.
 */
const RESERVED_SLUGS = Object.freeze([
  'www',
  'api',
  'admin',
  'app',
  'store',
  'mail',
  'ftp',
  'cdn',
  'ns1',
  'ns2',
  'blog',
  'help',
  'support',
  'status',
  'staging',
  'dev',
  'test',
]);

const RESERVED = new Set(RESERVED_SLUGS);

const FORMAT_MESSAGE =
  'Use lowercase letters, numbers and hyphens only, and do not start or end with a hyphen';

// Stable, machine-readable reasons — GET /workspaces/check-slug returns the
// key, and the merchant UI can show the matching message.
const REASON_MESSAGES = Object.freeze({
  invalid_format: FORMAT_MESSAGE,
  too_short: `Must be at least ${SLUG_MIN} characters`,
  too_long: `Must be at most ${SLUG_MAX} characters`,
  reserved: 'That address is reserved',
  taken: 'That address is already taken',
});

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * How a merchant-supplied slug is read before it is judged or stored, so
 * check-slug and PATCH can never disagree about the same input.
 */
function normalizeSlug(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Why `slug` may not be used, or null if it is fine. Does not consider
 * whether another workspace already holds it — that needs a DB lookup and
 * yields the separate 'taken' reason.
 */
function slugRejectionReason(slug) {
  if (typeof slug !== 'string' || slug.length === 0) return 'invalid_format';
  if (slug.length < SLUG_MIN) return 'too_short';
  if (slug.length > SLUG_MAX) return 'too_long';
  if (!SLUG_PATTERN.test(slug)) return 'invalid_format';
  if (RESERVED.has(slug)) return 'reserved';
  return null;
}

/**
 * Best-effort slug for a store *name*, used when a workspace is created and
 * nobody has chosen an address yet. Guarantees shape and length only: the
 * caller still has to settle uniqueness, and a candidate that lands on a
 * reserved label is handled there too (workspaceService suffixes it the same
 * way it suffixes one that is already taken), so this never has to invent a
 * second naming scheme.
 */
/**
 * `base` with `-<suffix>` appended, shortened as needed so the result still
 * fits in a DNS label. Without the shortening, suffixing a name that already
 * reached SLUG_MAX would produce an over-long slug that can never become
 * valid — and a caller retrying until it is would never terminate.
 */
function suffixSlug(base, suffix) {
  const tail = `-${suffix}`;
  return `${base.slice(0, SLUG_MAX - tail.length).replace(/-+$/, '')}${tail}`;
}

function toWorkspaceSlug(name) {
  const slug = String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, ''); // the slice may have left a trailing hyphen

  if (slug.length === 0) return 'shop'; // e.g. a name with no latin characters
  if (slug.length < SLUG_MIN) return `${slug}-store`;
  return slug;
}

/** A slug a merchant chooses. Strict; rejects the reserved list. */
const workspaceSlug = () =>
  Joi.string()
    .trim()
    .lowercase()
    .min(SLUG_MIN)
    .max(SLUG_MAX)
    .pattern(SLUG_PATTERN)
    .invalid(...RESERVED_SLUGS)
    .messages({
      'string.pattern.base': `"slug" ${FORMAT_MESSAGE}`,
      'any.invalid': '"slug" is reserved',
    });

/**
 * The `:workspaceId` of a public storefront path: either the workspace UUID
 * or its slug. Both are accepted everywhere so links keep working while
 * stores move over to subdomain addressing.
 */
const workspaceRef = () =>
  Joi.alternatives()
    .try(
      Joi.string().uuid(),
      Joi.string().lowercase().max(SLUG_LOOKUP_MAX).pattern(SLUG_PATTERN)
    )
    .messages({
      'alternatives.match': '"workspaceId" must be a workspace id or store address',
    });

module.exports = {
  SLUG_MIN,
  SLUG_MAX,
  SLUG_PATTERN,
  SLUG_LOOKUP_MAX,
  RESERVED_SLUGS,
  REASON_MESSAGES,
  isUuid,
  normalizeSlug,
  slugRejectionReason,
  toWorkspaceSlug,
  suffixSlug,
  workspaceSlug,
  workspaceRef,
};
