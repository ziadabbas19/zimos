'use strict';

const { FONT_CATALOG, FONT_CATEGORIES, FONT_SCRIPTS, fontById, isFontId, publicCatalog } = require('../../src/modules/fonts/fontCatalog');
const { fontPairProblems, storeFontsProblems, fontPairSchema } = require('../../src/modules/fonts/fontValidation');
const { validatePageTree } = require('../../src/modules/pages/pageTree');
const { pageSettingsSchema, resolvePageSettings } = require('../../src/modules/catalog/productPage');

// The store fonts (fonts/fontCatalog.js, fonts/fontValidation.js): one catalog,
// and every place a font is saved accepts a catalog id for the right script only.

const arabic = FONT_CATALOG.filter((f) => f.script === 'ar' || f.script === 'both');
const latin = FONT_CATALOG.filter((f) => f.script === 'latin' || f.script === 'both');
const arOnly = FONT_CATALOG.find((f) => f.script === 'ar').id;
const latinOnly = FONT_CATALOG.find((f) => f.script === 'latin').id;
const both = FONT_CATALOG.find((f) => f.script === 'both').id;

describe('the font catalog', () => {
  it('offers at least 40 Arabic and 40 English fonts', () => {
    expect(arabic.length).toBeGreaterThanOrEqual(40);
    expect(latin.length).toBeGreaterThanOrEqual(40);
  });

  it('gives every font a unique, URL-safe id and a family made of letters, digits and spaces only', () => {
    const ids = FONT_CATALOG.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const font of FONT_CATALOG) {
      expect(font.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      // The storefront writes the family into a stylesheet and a Google Fonts URL: nothing that could break out of either.
      expect(font.family).toMatch(/^[A-Za-z0-9 ]+$/);
    }
  });

  it('describes each font with a known script and category, its weights and its preview text', () => {
    for (const font of FONT_CATALOG) {
      expect(FONT_SCRIPTS).toContain(font.script);
      expect(FONT_CATEGORIES).toContain(font.category);
      expect(font.weights.length).toBeGreaterThan(0);
      expect([...font.weights].sort((a, b) => a - b)).toEqual(font.weights);
      for (const w of font.weights) expect(w % 100 === 0 && w >= 100 && w <= 900).toBe(true);
      if (font.variable) {
        expect(font.variable[0]).toBeLessThan(font.variable[1]);
      }
      expect(typeof font.preview).toBe('string');
      expect(font.preview.length).toBeGreaterThan(0);
    }
  });

  it('includes the families merchants ask for most', () => {
    for (const id of ['cairo', 'tajawal', 'almarai', 'noto-kufi-arabic', 'amiri', 'ibm-plex-sans-arabic']) {
      expect(isFontId(id, 'ar')).toBe(true);
    }
    for (const id of ['inter', 'poppins', 'montserrat', 'playfair-display', 'lora', 'bebas-neue']) {
      expect(isFontId(id, 'latin')).toBe(true);
    }
  });

  it('looks fonts up by id and checks their script', () => {
    expect(fontById('cairo')).toMatchObject({ family: 'Cairo' });
    expect(fontById('nope')).toBeNull();
    expect(fontById({ id: 'cairo' })).toBeNull();
    expect(isFontId(arOnly, 'latin')).toBe(false);
    expect(isFontId(latinOnly, 'ar')).toBe(false);
    expect(isFontId(both, 'ar')).toBe(true);
    expect(isFontId(both, 'latin')).toBe(true);
  });

  it('is what the public endpoint answers, with a version that names this list', () => {
    const body = publicCatalog();
    expect(body.fonts).toBe(FONT_CATALOG);
    expect(body.version).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('a font pair ({ ar, en })', () => {
  it('accepts catalog ids for the right script, null and absent', () => {
    expect(fontPairProblems(undefined, 'f')).toEqual([]);
    expect(fontPairProblems(null, 'f')).toEqual([]);
    expect(fontPairProblems({}, 'f')).toEqual([]);
    expect(fontPairProblems({ ar: arOnly, en: latinOnly }, 'f')).toEqual([]);
    expect(fontPairProblems({ ar: both, en: both }, 'f')).toEqual([]);
    expect(fontPairProblems({ ar: null, en: latinOnly }, 'f')).toEqual([]);
  });

  it('refuses an English face for Arabic text and an Arabic face for English text', () => {
    expect(fontPairProblems({ ar: latinOnly }, 'f')).toEqual([{ field: 'f.ar', message: '"ar" must be an Arabic font' }]);
    expect(fontPairProblems({ en: arOnly }, 'f')).toEqual([{ field: 'f.en', message: '"en" must be an English font' }]);
  });

  it('refuses family names, CSS and anything that is not a catalog id', () => {
    const bad = ['Cairo', 'cairo; color:red', '"Comic Sans"', 'x}body{background:url(//evil)}', 42, true, ['cairo'], { id: 'cairo' }, ''];
    for (const value of bad) {
      expect(fontPairProblems({ ar: value }, 'f')).toHaveLength(1);
      expect(fontPairProblems({ en: value }, 'f')).toHaveLength(1);
    }
  });

  it('refuses a pair that is not an object, and keys other than ar and en', () => {
    expect(fontPairProblems('cairo', 'f')).toHaveLength(1);
    expect(fontPairProblems(['cairo'], 'f')).toHaveLength(1);
    expect(fontPairProblems({ ar: arOnly, family: 'Cairo' }, 'f')).toEqual([{ field: 'f.family', message: 'Unknown font key "family" — use "ar" or "en"' }]);
  });

  it('has a Joi twin that agrees', () => {
    expect(fontPairSchema.validate(null).error).toBeUndefined();
    expect(fontPairSchema.validate({ ar: arOnly, en: latinOnly }).error).toBeUndefined();
    expect(fontPairSchema.validate({ ar: latinOnly }).error).toBeDefined();
    expect(fontPairSchema.validate({ en: 'Comic Sans' }).error).toBeDefined();
    expect(fontPairSchema.validate({ css: 'x' }).error).toBeDefined();
  });
});

describe("the store's fonts (themeSettings.fonts)", () => {
  it('accepts the primary faces and the header, footer and products pairs, each optional', () => {
    expect(storeFontsProblems(undefined)).toEqual([]);
    expect(storeFontsProblems(null)).toEqual([]);
    expect(storeFontsProblems({})).toEqual([]);
    expect(storeFontsProblems({ primaryAr: arOnly, primaryEn: latinOnly, header: { ar: both }, products: { en: latinOnly } })).toEqual([]);
    expect(storeFontsProblems({ primaryAr: null, primaryEn: null, header: null, products: null })).toEqual([]);
    expect(storeFontsProblems({ footer: { ar: arOnly, en: latinOnly } })).toEqual([]);
    expect(storeFontsProblems({ footer: null })).toEqual([]);
  });

  it('checks the footer pair like the others', () => {
    expect(storeFontsProblems({ footer: { ar: latinOnly } }).map((p) => p.field)).toEqual(['themeSettings.fonts.footer.ar']);
    expect(storeFontsProblems({ footer: { en: 'font-family:evil' } }).map((p) => p.field)).toEqual(['themeSettings.fonts.footer.en']);
    expect(storeFontsProblems({ footer: { css: 'x' } }).map((p) => p.field)).toEqual(['themeSettings.fonts.footer.css']);
  });

  it('names every problem: wrong script, unknown id, unknown key, bad shape', () => {
    const problems = storeFontsProblems({ primaryAr: latinOnly, primaryEn: 'Arial', header: 'cairo', layout: {} });
    expect(problems.map((p) => p.field)).toEqual([
      'themeSettings.fonts.primaryAr',
      'themeSettings.fonts.primaryEn',
      'themeSettings.fonts.header',
      'themeSettings.fonts.layout',
    ]);
    expect(problems[0].message).toBe('"primaryAr" must be an Arabic font');
    expect(storeFontsProblems('cairo')).toEqual([{ field: 'themeSettings.fonts', message: '"fonts" must be an object' }]);
  });
});

describe('fonts in a page tree', () => {
  const tree = ({ page, section, element } = {}) => ({
    version: 1,
    ...(page !== undefined ? { font: page } : {}),
    sections: [
      {
        id: 's1',
        type: 'section',
        ...(section !== undefined ? { settings: { padding: 'lg', font: section } } : {}),
        rows: [
          {
            id: 'r1',
            type: 'row',
            columns: [
              {
                id: 'c1',
                type: 'column',
                span: 12,
                elements: [{ id: 'e1', type: 'heading', props: { text: 'Hi' }, ...(element !== undefined ? { settings: { font: element } } : {}) }],
              },
            ],
          },
        ],
      },
    ],
  });
  const problems = (data) => {
    try {
      validatePageTree(data);
      return [];
    } catch (err) {
      return err.details.map((d) => d.field);
    }
  };

  it('leaves a tree without fonts exactly as valid as before', () => {
    expect(problems(tree())).toEqual([]);
  });

  it('accepts a font on the page, a section and an element', () => {
    expect(problems(tree({ page: { ar: arOnly }, section: { en: latinOnly }, element: { ar: both, en: both } }))).toEqual([]);
    expect(problems(tree({ page: null, section: null, element: null }))).toEqual([]);
  });

  it('refuses a bad font at each level, by its path', () => {
    expect(problems(tree({ page: { ar: 'Comic Sans' }, section: { en: arOnly }, element: { ar: latinOnly } }))).toEqual([
      'data.font.ar',
      'data.sections[0].settings.font.en',
      'data.sections[0].rows[0].columns[0].elements[0].settings.font.ar',
    ]);
  });
});

describe("a product's font (pageSettings.font)", () => {
  it('is null for every product that never set one', () => {
    expect(resolvePageSettings({}).font).toBeNull();
    expect(resolvePageSettings(null).font).toBeNull();
    expect(resolvePageSettings({ font: { ar: arOnly } }).font).toEqual({ ar: arOnly });
  });

  it('takes catalog ids only', () => {
    expect(pageSettingsSchema.validate({ font: { ar: arOnly, en: latinOnly } }).error).toBeUndefined();
    expect(pageSettingsSchema.validate({ font: null }).error).toBeUndefined();
    expect(pageSettingsSchema.validate({ font: { ar: latinOnly } }).error).toBeDefined();
    expect(pageSettingsSchema.validate({ font: { en: 'x;}' } }).error).toBeDefined();
  });
});
