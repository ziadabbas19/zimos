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
]);

const MAX_NODES = 10000;
const MAX_COLUMN_SPAN = 12;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

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

module.exports = { validatePageTree, ALLOWED_ELEMENT_TYPES, EMPTY_TREE, MAX_NODES };
