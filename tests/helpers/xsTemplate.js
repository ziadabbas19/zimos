'use strict';

/**
 * A small store template in the shape the imported templates ("xs" looks)
 * are pasted into the platform console: every page made of xs_* bands, one
 * band per section, and the look's shell (xsLook, header, footer) in its
 * themeSettings. Written here by hand — the props are a fair sample of what
 * the editor saves (nested lists, a picture's focus, a value per screen, a
 * band's own colours), not a copy of any one template.
 */

/** The 17 band types the templates use, as the frontend names them. */
const XS_ELEMENT_TYPES = [
  'xs_banners',
  'xs_contact',
  'xs_features',
  'xs_gallery',
  'xs_hero',
  'xs_minis',
  'xs_newsletter',
  'xs_posts',
  'xs_products',
  'xs_quotes',
  'xs_showcase',
  'xs_slider',
  'xs_split',
  'xs_story',
  'xs_team',
  'xs_title',
  'xs_video',
];

const PROPS = {
  xs_slider: {
    look: '01',
    slides: [
      { image: '/xs/01/slide-01.jpg', eyebrow: 'Women Collection', heading: 'NEW SEASON', buttonLabel: 'Shop Now', buttonHref: '/products' },
      { image: '/xs/01/slide-02.jpg', eyebrow: 'Men New-Season', heading: 'Jackets & Coats', buttonLabel: 'Shop Now', buttonHref: '/products', imagePosition: '30% 50%' },
    ],
    autoplay: true,
    seconds: 6,
  },
  xs_banners: {
    look: '01',
    items: [{ image: '/xs/01/banner-01.jpg', title: 'Women', text: 'Spring', linkLabel: 'Shop Now', href: '/products' }],
  },
  xs_products: {
    look: '01',
    heading: 'Product Overview',
    collection: '',
    limit: 8,
    showDiscount: true,
    showTabs: true,
    tabs: [{ label: 'Women', collection: 'women' }],
    layout: 'grid',
  },
  xs_title: {
    look: '01',
    title: 'About',
    image: '/xs/01/title.jpg',
    headingColor: '#222222',
    paddingTop: { base: 80, tablet: 60, mobile: 40 },
  },
  xs_story: { look: '02', heading: 'Our story', text: 'Two lines\nabout the shop.', image: '/xs/02/about-01.jpg', imagePosition: '40% 60%' },
  xs_contact: {
    look: '01',
    heading: 'Send us a message',
    address: 'Cairo',
    phone: '+20 100 000 0000',
    email: 'hello@example.com',
    contactPlaceholder: 'Your email or phone',
    messagePlaceholder: 'How can we help?',
    buttonLabel: 'Submit',
  },
  xs_hero: { look: '02', heading: 'Modern interior', text: 'Made to last.', buttonLabel: 'Shop', buttonHref: '/products', image: '/xs/02/sofa.png' },
  xs_showcase: { look: '05', items: [{ image: '/xs/05/bags.jpg', title: 'Bags', href: '/products' }] },
  xs_features: { look: '02', items: [{ icon: 'truck', title: 'Fast shipping', text: 'Two days in Cairo.' }] },
  xs_split: { look: '02', heading: 'Crafted with care', text: 'Every piece by hand.', image: '/xs/02/img-grid-1.jpg', flip: true },
  xs_minis: { look: '12', items: [{ image: '/xs/12/mini-01.png', title: 'Headphones', price: '450' }] },
  xs_quotes: { look: '02', items: [{ quote: 'Write here what a customer told you.', name: '', role: '', image: '/xs/02/person.jpg' }] },
  xs_gallery: { look: '03', images: ['/xs/03/gallery-01.jpg', '/xs/03/gallery-02.jpg'], imageHeight: { base: 320, mobile: 200 } },
  xs_newsletter: { look: '01', heading: 'Newsletter', placeholder: 'Email', buttonLabel: 'Subscribe' },
  xs_team: { look: '09', items: [{ name: 'Your name', role: 'Founder', image: '/xs/09/team-01.jpg' }] },
  xs_video: { look: '03', heading: '', url: '' },
  xs_posts: { look: '01', items: [{ title: 'Spring looks', date: '2026-03-01', image: '/xs/01/blog-01.jpg', href: '/about' }] },
};

/** One band of `type`, its ids named by `key`. */
function xsElement(type, key = type) {
  return { id: `${key}-e`, type, props: JSON.parse(JSON.stringify(PROPS[type])) };
}

/** A page tree holding `types`, one full-width section each, as the templates are built. */
function xsPage(key, types) {
  return {
    version: 1,
    sections: types.map((type, i) => {
      const id = `${key}-s${i + 1}`;
      return {
        id,
        type: 'section',
        settings: { width: 'full', padding: 'tight' },
        rows: [
          {
            id: `${id}-r1`,
            type: 'row',
            columns: [{ id: `${id}-c1`, type: 'column', span: 12, elements: [xsElement(type, id)] }],
          },
        ],
      };
    }),
  };
}

/** The look's shell, as the store's themeSettings get it when it takes the template. */
function xsThemeSettings() {
  return {
    xsLook: '01',
    header: {
      announcement: { enabled: true, text: 'Free shipping over EGP 1,500' },
      menu: [
        { label: 'Home', href: '/', kind: 'home' },
        { label: 'Shop', href: '/products', kind: 'url' },
        { label: 'About', href: '/about', kind: 'page' },
      ],
      show: { theme: false, trackOrder: false, language: false },
      zones: { notice: [{ id: 'notice', type: 'notice' }], start: [{ id: 'logo', type: 'logo' }], end: [{ id: 'cart', type: 'cart' }] },
      colors: { background: '#ffffff', text: '#333333' },
      sizes: { logo: { base: 40, mobile: 28 } },
    },
    footer: {
      columns: [{ title: 'Help', links: [{ label: 'Contact', href: '/contact' }] }],
      bottom: { text: 'All rights reserved.' },
    },
  };
}

/** A template version as the console's "add version" takes it. */
function xsTemplateVersion() {
  return {
    globalStyles: { primaryColor: '#717FE0', themeSettings: xsThemeSettings() },
    pages: [
      { path: '/', title: 'Home', pageType: 'home', builderData: xsPage('home', XS_ELEMENT_TYPES), seo: {} },
      { path: '/about', title: 'About', pageType: 'static', builderData: xsPage('about', ['xs_title', 'xs_story', 'xs_team']), seo: {} },
      { path: '/contact', title: 'Contact', pageType: 'static', builderData: xsPage('contact', ['xs_title', 'xs_contact']), seo: {} },
    ],
    sections: [],
  };
}

module.exports = { XS_ELEMENT_TYPES, xsElement, xsPage, xsThemeSettings, xsTemplateVersion };
