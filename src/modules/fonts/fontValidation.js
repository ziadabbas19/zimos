'use strict';

const Joi = require('joi');
const { FONT_CATALOG, isFontId } = require('./fontCatalog');

/*
 * Where a merchant's font choice is stored, and the one check every place
 * runs on it: a font is an id from the catalog (fontCatalog.js), and an id
 * picked for Arabic text must be an Arabic face, one picked for English text
 * a Latin face. Nothing else is accepted — no family names, no CSS — so what
 * the storefront writes into a stylesheet always comes from the catalog.
 *
 *   A font pair (any part of the store that can have its own font):
 *     { ar: '<id>' | null, en: '<id>' | null }
 *     null or absent = use what the part sits in (its section, its page, the store)
 *
 *   themeSettings.fonts (the whole store):
 *     { primaryAr, primaryEn,      the store's Arabic and English faces
 *       header:   { ar, en },      the store name, menu and announcement bar
 *       products: { ar, en } }     product pages and product cards
 *     every key optional; absent or null = the store's look as it was before
 *
 *   A page tree (pages/pageTree.js):  data.font, section.settings.font,
 *                                     element.settings.font — each a pair
 *   A product (catalog/productPage.js): pageSettings.font — a pair
 */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const SCRIPT_OF = { ar: 'ar', en: 'latin' };
const LABEL = { ar: 'an Arabic font', en: 'an English font' };

function idProblem(value, key, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !isFontId(value)) {
    return { field, message: `"${key}" must be the id of a font from the font catalog` };
  }
  if (!isFontId(value, SCRIPT_OF[key])) return { field, message: `"${key}" must be ${LABEL[key]}` };
  return null;
}

/** The problems with one `{ ar, en }` pair; none for null or absent. Unknown keys are refused. */
function fontPairProblems(pair, field) {
  if (pair === null || pair === undefined) return [];
  if (!isPlainObject(pair)) return [{ field, message: 'A font must be an object like { "ar": "<font id>", "en": "<font id>" }' }];
  const problems = [];
  for (const [key, value] of Object.entries(pair)) {
    if (!Object.hasOwn(SCRIPT_OF, key)) {
      problems.push({ field: `${field}.${key}`, message: `Unknown font key "${key}" — use "ar" or "en"` });
      continue;
    }
    const problem = idProblem(value, key, `${field}.${key}`);
    if (problem) problems.push(problem);
  }
  return problems;
}

const STORE_PAIRS = ['header', 'footer', 'products'];

/** The problems with `themeSettings.fonts`; none for null or absent. */
function storeFontsProblems(fonts, field = 'themeSettings.fonts') {
  if (fonts === null || fonts === undefined) return [];
  if (!isPlainObject(fonts)) return [{ field, message: '"fonts" must be an object' }];
  const problems = [];
  for (const [key, value] of Object.entries(fonts)) {
    const at = `${field}.${key}`;
    if (key === 'primaryAr' || key === 'primaryEn') {
      const problem = idProblem(value, key === 'primaryAr' ? 'ar' : 'en', at);
      if (problem) problems.push({ ...problem, message: problem.message.replace(/^"(ar|en)"/, `"${key}"`) });
    } else if (STORE_PAIRS.includes(key)) {
      problems.push(...fontPairProblems(value, at));
    } else {
      problems.push({ field: at, message: `Unknown key "${key}" — use primaryAr, primaryEn, header, footer or products` });
    }
  }
  return problems;
}

const idsFor = (script) => FONT_CATALOG.filter((f) => f.script === 'both' || f.script === script).map((f) => f.id);

/** The pair as a Joi schema, for request bodies validated by Joi (a product's pageSettings). */
const fontPairSchema = Joi.object({
  ar: Joi.string()
    .valid(...idsFor('ar'))
    .allow(null)
    .messages({ 'any.only': '{#label} must be an Arabic font from the font catalog' }),
  en: Joi.string()
    .valid(...idsFor('latin'))
    .allow(null)
    .messages({ 'any.only': '{#label} must be an English font from the font catalog' }),
})
  .unknown(false)
  .allow(null);

module.exports = { fontPairProblems, storeFontsProblems, fontPairSchema };
