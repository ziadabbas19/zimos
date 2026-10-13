'use strict';

const { validatePageTree, ELEMENT_PROP_RULES } = require('../../src/modules/pages/pageTree');

// The page tree gate (pages/pageTree): what an editor saves is what every
// shopper's browser renders, so a button's link is held to the same URL rule
// as every other link in the tree.

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
describe("a button's link", () => {
  it.each([
    ['javascript:void(0)'],
    ['JavaScript:alert(1)'],
    ['java\nscript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['vbscript:msgbox(1)'],
    ['//evil.example/phish'],
  ])('refuses %j', (href) => {
    expect(problems(button({ text: 'Buy', href }))).toEqual([`${AT}.href: "href" must be a http(s), mailto:, tel: or same-site URL`]);
  });

  it.each([['https://shop.example.com/sale'], ['http://shop.example.com'], ['/checkout'], ['products/42'], ['#order-form'], ['mailto:hi@example.com'], ['tel:+201000000000'], ['']])(
    'accepts %j',
    (href) => {
      expect(problems(button({ text: 'Buy', href }))).toEqual([]);
    }
  );

  it('still checks what the button already had, and a button with no link at all is fine', () => {
    expect(problems(button({ text: 'Buy' }))).toEqual([]);
    expect(problems(button({ action: 'add_to_cart', productId: '', href: null }))).toEqual([]);
    expect(problems(button({ action: 'explode' }))).toEqual([`${AT}.action: "action" must be one of: link, add_to_cart, buy_now`]);
    expect(Object.keys(ELEMENT_PROP_RULES.button).sort()).toEqual(['action', 'href', 'productId', 'variantId']);
  });

  it('holds a text link to the same rule, as before', () => {
    expect(problems({ id: 't1', type: 'text_link', props: { text: 'x', href: 'javascript:void(0)' } })).toHaveLength(1);
  });
});
