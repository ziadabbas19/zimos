'use strict';

const { ValidationError } = require('../../core/errors/AppError');

/**
 * Pages are stored as a structured JSON tree, never raw HTML. Shape:
 *   { version: <int>, sections: [ section -> row -> column -> element ] }
 *
 * `validatePageTree` enforces that on every write, collecting all problems
 * into one ValidationError with a `field` path per problem. Raw HTML is
 * rejected two ways: a string where a node is expected fails, and there is
 * no html/raw_html element type.
 */

const ALLOWED_ELEMENT_TYPES = new Set([
  'heading',
  'text',
  'rich_text',
  'image',
  'gallery',
  'button',
  'video',
  'embed',
  'spacer',
  'divider',
  'icon',
  'list',
  'accordion',
  'faq',
  'testimonial',
  'countdown',
  'form',
  'map',
  'social_icons',
  'product_card',
  'product_list',
  'collection_list',
  'cart',
  // Motion/"awwwards" sections. Like every other type these are structured
  // props the frontend renders — never markup — so adding them cannot open a
  // raw-HTML hole. Their prop contract is checked by ELEMENT_PROP_RULES below.
  'shader_hero',
  'product_3d',
  'orbit_gallery',
  'scroll_story',
  'marquee',
  'comparison',
]);

const MAX_NODES = 10000;
const MAX_COLUMN_SPAN = 12;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// --- URL safety -------------------------------------------------------
// Anything that ends up in an href/src attribute goes through this. Page
// trees are authored by staff, but a compromised or careless editor session
// must not be able to plant `javascript:`/`data:` in a link that then runs on
// every shopper's browser. Relative paths and in-page anchors stay allowed
// because that is what internal links look like.
const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

function isSafeUrl(value) {
  if (typeof value !== 'string') return false;
  // Browsers ignore control characters inside a scheme, so a "javascript:"
  // split by a newline or a NUL is still live markup to them — strip those
  // out before deciding what the scheme is.
  const v = value.replace(/[\u0000-\u001F\u007F]+/g, '').trim();
  if (v === '') return true; // "not set yet" — the builder saves partial drafts
  if (v.startsWith('#')) return true; // in-page anchor
  if (v.startsWith('//')) return false; // protocol-relative: inherits whatever we are on
  if (v.startsWith('/')) return true; // same-site absolute path
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(v)) return true; // relative path ("about", "products/42")
  try {
    return SAFE_URL_SCHEMES.has(new URL(v).protocol);
  } catch (err) {
    return false;
  }
}

// --- per-type prop contracts -------------------------------------------
// Only the newer motion sections declare one; the original types keep the
// "props is an object" contract they were written with, and are left alone.
// Every prop is optional — the builder autosaves half-filled sections — so
// these rules police shape and size, not presence.
const check = {
  string: (max) => (v) => (typeof v === 'string' && v.length <= max ? null : `must be a string of at most ${max} characters`),
  url: (v) => (isSafeUrl(v) ? null : 'must be a http(s), mailto:, tel: or same-site URL'),
  uuid: (v) =>
    typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
      ? null
      : 'must be a UUID',
  intRange: (min, max) => (v) =>
    Number.isInteger(v) && v >= min && v <= max ? null : `must be a whole number between ${min} and ${max}`,
  oneOf: (...allowed) => (v) => (allowed.includes(v) ? null : `must be one of: ${allowed.join(', ')}`),
  // A size that the frontend may express either as a keyword or as a pixel count.
  size: (v) =>
    (typeof v === 'string' && v.length <= 20) || (Number.isFinite(v) && v > 0)
      ? null
      : 'must be a size keyword or a positive number',
  boolOrString: (max) => (v) =>
    typeof v === 'boolean' || (typeof v === 'string' && v.length <= max)
      ? null
      : `must be a boolean or a string of at most ${max} characters`,
  listOf: (maxItems, itemRule) => (v, field, errors) => {
    if (!Array.isArray(v)) return `must be an array`;
    if (v.length > maxItems) return `must hold at most ${maxItems} items`;
    v.forEach((entry, i) => applyRule(itemRule, entry, `${field}[${i}]`, errors));
    return null;
  },
  // A nested object with its own per-key rules (a scroll_story step, a
  // comparison row). Unknown keys are left alone, like props themselves.
  shape: (rules) => (v, field, errors) => {
    if (!isPlainObject(v)) return 'must be an object';
    validateProps(v, rules, field, errors);
    return null;
  },
};

function applyRule(rule, value, field, errors) {
  if (value === undefined || value === null) return; // unset is always fine
  const message = rule(value, field, errors);
  if (message) errors.push({ field, message: `"${field.split('.').pop()}" ${message}` });
}

function validateProps(props, rules, field, errors) {
  for (const [key, rule] of Object.entries(rules)) {
    applyRule(rule, props[key], `${field}.${key}`, errors);
  }
}

const ELEMENT_PROP_RULES = {
  shader_hero: {
    title: check.string(300),
    subtitle: check.string(600),
    ctaLabel: check.string(100),
    ctaHref: check.url,
    height: check.size,
  },
  product_3d: {
    title: check.string(300),
    productId: check.uuid,
    modelUrl: check.url,
  },
  orbit_gallery: {
    title: check.string(300),
    limit: check.intRange(1, 50),
    collectionId: check.uuid,
  },
  scroll_story: {
    title: check.string(300),
    steps: check.listOf(
      12,
      check.shape({ title: check.string(300), body: check.string(2000), image: check.url })
    ),
  },
  marquee: {
    items: check.listOf(30, check.string(200)),
    speed: check.oneOf('slow', 'normal', 'fast'),
    tone: check.oneOf('line', 'primary'),
  },
  comparison: {
    title: check.string(300),
    usLabel: check.string(100),
    themLabel: check.string(100),
    rows: check.listOf(
      20,
      check.shape({ label: check.string(300), us: check.boolOrString(200), them: check.boolOrString(200) })
    ),
  },
};

function pushIdCheck(node, field, errors) {
  if (typeof node.id !== 'string' || node.id.trim() === '') {
    errors.push({ field: `${field}.id`, message: 'Every node needs a non-empty string "id"' });
  }
}

function validateElement(el, field, errors, counter) {
  counter.n += 1;
  if (typeof el === 'string') {
    errors.push({ field, message: 'An element must be a structured node object, not a raw HTML/text string' });
    return;
  }
  if (!isPlainObject(el)) {
    errors.push({ field, message: 'An element must be an object' });
    return;
  }
  pushIdCheck(el, field, errors);
  if (typeof el.type !== 'string' || el.type.trim() === '') {
    errors.push({ field: `${field}.type`, message: 'Element is missing a "type"' });
  } else if (!ALLOWED_ELEMENT_TYPES.has(el.type)) {
    errors.push({
      field: `${field}.type`,
      message: `Unknown element type "${el.type}". Raw HTML blocks are not allowed; use a structured element type.`,
    });
  }
  if (el.props !== undefined && !isPlainObject(el.props)) {
    errors.push({ field: `${field}.props`, message: '"props" must be an object when present' });
  } else if (isPlainObject(el.props) && ELEMENT_PROP_RULES[el.type]) {
    validateProps(el.props, ELEMENT_PROP_RULES[el.type], `${field}.props`, errors);
  }
  if (el.settings !== undefined && !isPlainObject(el.settings)) {
    errors.push({ field: `${field}.settings`, message: '"settings" must be an object when present' });
  }
}

function validateColumn(col, field, errors, counter) {
  counter.n += 1;
  if (typeof col === 'string' || !isPlainObject(col)) {
    errors.push({ field, message: 'A column must be an object' });
    return;
  }
  pushIdCheck(col, field, errors);
  if (col.type !== 'column') {
    errors.push({ field: `${field}.type`, message: 'A column node must have type "column"' });
  }
  if (col.span !== undefined) {
    if (!Number.isInteger(col.span) || col.span < 1 || col.span > MAX_COLUMN_SPAN) {
      errors.push({ field: `${field}.span`, message: `"span" must be an integer between 1 and ${MAX_COLUMN_SPAN}` });
    }
  }
  if (!Array.isArray(col.elements)) {
    errors.push({ field: `${field}.elements`, message: 'A column must have an "elements" array' });
    return;
  }
  col.elements.forEach((el, i) => validateElement(el, `${field}.elements[${i}]`, errors, counter));
}

function validateRow(row, field, errors, counter) {
  counter.n += 1;
  if (typeof row === 'string' || !isPlainObject(row)) {
    errors.push({ field, message: 'A row must be an object' });
    return;
  }
  pushIdCheck(row, field, errors);
  if (row.type !== 'row') {
    errors.push({ field: `${field}.type`, message: 'A row node must have type "row"' });
  }
  if (!Array.isArray(row.columns)) {
    errors.push({ field: `${field}.columns`, message: 'A row must have a "columns" array' });
    return;
  }
  row.columns.forEach((col, i) => validateColumn(col, `${field}.columns[${i}]`, errors, counter));
}

function validateSection(section, field, errors, counter) {
  counter.n += 1;
  if (typeof section === 'string' || !isPlainObject(section)) {
    errors.push({ field, message: 'A section must be an object, not a string' });
    return;
  }
  pushIdCheck(section, field, errors);
  if (section.type !== 'section') {
    errors.push({ field: `${field}.type`, message: 'A section node must have type "section"' });
  }
  if (!Array.isArray(section.rows)) {
    errors.push({ field: `${field}.rows`, message: 'A section must have a "rows" array' });
    return;
  }
  section.rows.forEach((row, i) => validateRow(row, `${field}.rows[${i}]`, errors, counter));
}

function countElements(sections) {
  let count = 0;
  for (const s of sections || []) {
    for (const r of (s && s.rows) || []) {
      for (const c of (r && r.columns) || []) {
        count += ((c && c.elements) || []).length;
      }
    }
  }
  return count;
}

/**
 * @param {*} data       the candidate tree
 * @param {object} opts
 * @param {boolean} opts.requireContent  when true (publish), an empty tree is rejected
 * @param {string}  opts.label           used only in error messages ("page \"/about\"")
 * @returns {object} the validated tree (unchanged)
 * @throws {ValidationError} with a details[] listing every problem
 */
function validatePageTree(data, { requireContent = false, label = 'page' } = {}) {
  const errors = [];

  if (typeof data === 'string') {
    throw new ValidationError(
      [{ field: 'data', message: 'Page content must be a structured section tree, not a raw HTML string' }],
      `Invalid content for ${label}`
    );
  }
  if (!isPlainObject(data)) {
    throw new ValidationError(
      [{ field: 'data', message: 'Page content must be an object with a "sections" array' }],
      `Invalid content for ${label}`
    );
  }

  if (data.version !== undefined && !Number.isInteger(data.version)) {
    errors.push({ field: 'data.version', message: '"version" must be an integer when present' });
  }
  if (data.globalStyles !== undefined && !isPlainObject(data.globalStyles)) {
    errors.push({ field: 'data.globalStyles', message: '"globalStyles" must be an object when present' });
  }

  const sections = data.sections;
  if (!Array.isArray(sections)) {
    errors.push({ field: 'data.sections', message: '"sections" must be an array' });
    throw new ValidationError(errors, `Invalid content for ${label}`);
  }

  const counter = { n: 0 };
  sections.forEach((section, i) => validateSection(section, `data.sections[${i}]`, errors, counter));

  if (counter.n > MAX_NODES) {
    errors.push({ field: 'data', message: `Page tree is too large (${counter.n} nodes, max ${MAX_NODES})` });
  }

  if (requireContent) {
    if (sections.length === 0) {
      errors.push({
        field: 'data.sections',
        message: 'Cannot publish an empty page — add at least one section with content before publishing',
      });
    } else if (countElements(sections) === 0) {
      errors.push({
        field: 'data.sections',
        message:
          'This page has sections but no content elements — add text, an image or another element before publishing',
      });
    }
  }

  if (errors.length) {
    throw new ValidationError(errors, `Invalid content for ${label}`);
  }
  return data;
}

const EMPTY_TREE = Object.freeze({ version: 1, sections: [] });

module.exports = { validatePageTree, ALLOWED_ELEMENT_TYPES, ELEMENT_PROP_RULES, isSafeUrl, EMPTY_TREE, MAX_NODES };
