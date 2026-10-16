'use strict';

const env = require('../../src/config/env');
const { validatePageTree, ALLOWED_ELEMENT_TYPES, ELEMENT_PROP_RULES } = require('../../src/modules/pages/pageTree');
const xs = require('../../src/modules/pages/xsElements');
const { ValidationError } = require('../../src/core/errors/AppError');
const { allowedElements } = require('../../src/modules/ai/features');
const adminSchemas = require('../../src/modules/platformAdmin/platformAdminValidation');
const pageSchemas = require('../../src/modules/pages/pagesValidation');
const workspaceSchemas = require('../../src/modules/workspaces/workspaceValidation');
const { XS_ELEMENT_TYPES, xsElement, xsPage, xsThemeSettings, xsTemplateVersion } = require('../helpers/xsTemplate');

// The imported store templates' bands (pages/xsElements.js) through the page
// tree gate, and an xs template through the request schemas that carry it:
// nothing refused, nothing stripped. No database: nothing here queries one.

const treeWith = (...elements) => ({
  version: 1,
  sections: [{ id: 's1', type: 'section', rows: [{ id: 'r1', type: 'row', columns: [{ id: 'c1', type: 'column', span: 12, elements }] }] }],
});
const copy = (value) => JSON.parse(JSON.stringify(value));
const AT = 'data.sections[0].rows[0].columns[0].elements[0]';
// The same options as the validate middleware (core/middleware/validate.js).
const asTheMiddleware = (schema, value) => schema.validate(value, { abortEarly: false, stripUnknown: true });

describe("the imported templates' element types (xs_*)", () => {
  it('are the 17 the templates use, every one allowed', () => {
    expect([...xs.TYPES].sort()).toEqual(XS_ELEMENT_TYPES);
    for (const type of XS_ELEMENT_TYPES) expect(ALLOWED_ELEMENT_TYPES.has(type)).toBe(true);
    for (const type of XS_ELEMENT_TYPES) expect(xs.isXsType(type)).toBe(true);
    expect(xs.isXsType('hero_slider')).toBe(false);
  });

  it.each(XS_ELEMENT_TYPES)('%s is accepted, its props kept as they are', (type) => {
    const tree = treeWith(xsElement(type));
    const before = copy(tree);
    expect(validatePageTree(tree)).toBe(tree);
    expect(tree).toEqual(before);
  });

  it('a whole template page of them passes untouched, and can be published', () => {
    const tree = xsPage('home', XS_ELEMENT_TYPES);
    const before = copy(tree);
    expect(validatePageTree(tree, { requireContent: true, label: 'page "/"' })).toBe(tree);
    expect(tree).toEqual(before);
  });

  it('an unknown type is still refused, with the same code, field and message', () => {
    for (const type of ['xs_bogus', 'XS_SLIDER', 'xs_', 'raw_html']) {
      let caught = null;
      try {
        validatePageTree(treeWith({ id: 'e1', type, props: {} }));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ValidationError);
      expect(caught.statusCode).toBe(422);
      expect(caught.code).toBe('VALIDATION_ERROR');
      expect(caught.details).toEqual([
        { field: `${AT}.type`, message: `Unknown element type "${type}". Raw HTML blocks are not allowed; use a structured element type.` },
      ]);
    }
  });

  it('a raw HTML string in the place of a band is still refused', () => {
    expect(() => validatePageTree(treeWith('<div class="xs-hero">hi</div>'))).toThrow(ValidationError);
  });

  it('have no prop rules, so PAGE_TREE_STRICT_PROPS — off, and left off — would leave their props alone too', () => {
    expect(env.pages.strictProps).toBe(false);
    for (const type of XS_ELEMENT_TYPES) expect(ELEMENT_PROP_RULES[type]).toBeUndefined();
    const saved = env.pages.strictProps;
    try {
      env.pages.strictProps = true;
      expect(() => validatePageTree(xsPage('home', XS_ELEMENT_TYPES))).not.toThrow();
    } finally {
      env.pages.strictProps = saved;
    }
    expect(env.pages.strictProps).toBe(false);
  });

  it('are not offered to the AI features, which still get every other type', () => {
    const offered = allowedElements();
    for (const type of XS_ELEMENT_TYPES) expect(offered).not.toContain(type);
    expect(offered.sort()).toEqual([...ALLOWED_ELEMENT_TYPES].filter((type) => !type.startsWith('xs_')).sort());
  });
});

describe('an xs template through the request schemas (stripUnknown, as the middleware runs them)', () => {
  it("the console's add version keeps every page, band and the look's shell", () => {
    const body = xsTemplateVersion();
    const { error, value } = asTheMiddleware(adminSchemas.createTemplateVersion.body, copy(body));
    expect(error).toBeUndefined();
    expect(value).toEqual({ ...body, activate: true });
  });

  it("the console's new template takes the gallery card the templates are listed with", () => {
    const card = { name: 'XS 01 عربي', kind: 'store', category: 'food_beverage', tags: ['xs', 'ar'], rtl: true, primaryColor: '#717FE0' };
    const { error, value } = asTheMiddleware(adminSchemas.createTemplate.body, copy(card));
    expect(error).toBeUndefined();
    expect(value).toMatchObject(card);
  });

  it("the editor's page save keeps the tree whole", () => {
    const draftData = xsPage('home', XS_ELEMENT_TYPES);
    const { error, value } = asTheMiddleware(pageSchemas.updatePage.body, { draftData: copy(draftData) });
    expect(error).toBeUndefined();
    expect(value.draftData).toEqual(draftData);
  });

  it("the store's settings keep the look's shell, well under the size the service allows", () => {
    const themeSettings = xsThemeSettings();
    const { error, value } = asTheMiddleware(workspaceSchemas.updateWorkspace.body, { themeSettings: copy(themeSettings) });
    expect(error).toBeUndefined();
    expect(value.themeSettings).toEqual(themeSettings);
    expect(JSON.stringify(themeSettings).length).toBeLessThan(5000);
  });
});
