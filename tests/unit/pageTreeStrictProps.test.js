'use strict';

const env = require('../../src/config/env');
const { validatePageTree, ELEMENT_PROP_RULES } = require('../../src/modules/pages/pageTree');

// The page tree gate (pages/pageTree) behind PAGE_TREE_STRICT_PROPS: a prop no
// rule has looked at is refused instead of being stored for the storefront.

const treeWith = (...elements) => ({
  version: 1,
  sections: [{ id: 's1', type: 'section', rows: [{ id: 'r1', type: 'row', columns: [{ id: 'c1', type: 'column', span: 12, elements }] }] }],
});
const problems = (...elements) => {
  try {
    validatePageTree(treeWith(...elements));
    return [];
  } catch (err) {
    return err.details.map((d) => `${d.field}: ${d.message}`);
  }
};
const button = (props) => ({ id: 'b1', type: 'button', props });
const AT = 'data.sections[0].rows[0].columns[0].elements[0].props';
describe('props no rule names', () => {
  const saved = env.pages.strictProps;
  afterEach(() => {
    env.pages.strictProps = saved;
  });

  const unknownOnButton = button({ text: 'Buy', onclick: 'steal()', formAction: 'https://evil.example' });
  const nested = {
    id: 'c1',
    type: 'comparison',
    props: { title: 'Us and them', rows: [{ label: 'Price', us: true, them: false, html: '<img src=x>' }] },
  };

  it('switch off (the default): they are stored unchecked, as before', () => {
    expect(env.pages.strictProps).toBe(false);
    expect(problems(unknownOnButton)).toEqual([]);
    expect(problems(nested)).toEqual([]);
  });

  it('switch on: refused on a type that has rules, each by name', () => {
    env.pages.strictProps = true;
    expect(problems(unknownOnButton)).toEqual([`${AT}.text: Unknown prop "text"`, `${AT}.onclick: Unknown prop "onclick"`, `${AT}.formAction: Unknown prop "formAction"`]);
  });

  it('switch on: refused inside a nested object too', () => {
    env.pages.strictProps = true;
    expect(problems(nested)).toEqual([`${AT}.rows[0].html: Unknown prop "html"`]);
  });

  it('switch on: the props the rules name, bindings and contact tags still pass', () => {
    env.pages.strictProps = true;
    expect(problems(button({ href: '/checkout', action: 'link', bindings: { href: 'store.phone' }, contactTags: ['interested'] }))).toEqual([]);
    expect(problems({ id: 't1', type: 'text_link', props: { text: 'Read more', href: '/about', newTab: true } })).toEqual([]);
    // A binding is still checked by its own rule.
    expect(problems(button({ bindings: { href: 'window.location' } }))).toHaveLength(1);
  });

  it('switch on: a type with no rule set is still not checked', () => {
    env.pages.strictProps = true;
    expect(ELEMENT_PROP_RULES.heading).toBeUndefined();
    expect(problems({ id: 'h1', type: 'heading', props: { text: 'Hello', anything: 'goes' } })).toEqual([]);
  });
});
