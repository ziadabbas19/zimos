'use strict';

/**
 * What a store sells, asked once on the store setup step (optional). The
 * dashboard shows these as one-tap choices; "other" comes with a short text
 * (business_type_other). Migration 753 holds the same list in a CHECK, so a
 * new entry here needs a migration that swaps that constraint.
 */
const BUSINESS_TYPES = Object.freeze([
  'fashion',
  'electronics',
  'beauty',
  'food',
  'home',
  'accessories',
  'kids',
  'sports',
  'services',
  'other',
]);

const BUSINESS_TYPE_OTHER_MAX = 80;

/**
 * The two columns as stored: the text only goes with "other", and blank
 * text is no text.
 */
function businessTypeColumns(businessType, businessTypeOther) {
  if (!businessType) return { businessType: null, businessTypeOther: null };
  const other = businessType === 'other' ? String(businessTypeOther || '').trim() : '';
  return { businessType, businessTypeOther: other ? other.slice(0, BUSINESS_TYPE_OTHER_MAX) : null };
}

module.exports = { BUSINESS_TYPES, BUSINESS_TYPE_OTHER_MAX, businessTypeColumns };
