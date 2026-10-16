'use strict';

const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const { keyOf } = require('../../src/modules/translations/contentTranslations');

/**
 * What an imported template's store can translate (Languages → translate):
 * the words of its bands that are not plain headings (links' and buttons'
 * words, a team member's role, a post's date line, the shop band's tools, a
 * band's points), and its header and footer, which live in themeSettings
 * (entity `shell`) and are put in the shopper's language on GET /store/:ws.
 */

const el = (id, type, props) => ({ id, type, props });
function tree(elements) {
  return {
    version: 1,
    sections: [{ id: 's1', type: 'section', settings: {}, rows: [{ id: 'r1', type: 'row', settings: {}, columns: [{ id: 'c1', type: 'column', span: 12, settings: {}, elements }] }] }],
  };
}

const BANDS = [
  el('e1', 'xs_hero', { look: '01', heading: 'بيت هادي', buttonLabel: 'تسوق', button2Label: 'اكتشف', buttonHref: '/products' }),
  el('e2', 'xs_products', { look: '01', heading: 'المنتجات', allLabel: 'كل المنتجات', searchLabel: 'بحث', searchPlaceholder: 'ابحث هنا', loadMoreLabel: 'المزيد', viewLabel: 'عرض', openLabel: 'افتح' }),
  el('e3', 'xs_team', { look: '01', items: [{ name: 'سارة', role: 'مديرة التصميم' }] }),
  el('e4', 'xs_posts', { look: '01', items: [{ title: 'خبر', meta: 'يوليو 2026', linkLabel: 'اقرأ المزيد' }] }),
  el('e5', 'xs_split', { look: '01', eyebrow: 'عرض', points: ['خامة ممتازة', 'شحن سريع'], countdownLabels: ['يوم', 'ساعة', 'دقيقة', 'ثانية'] }),
  el('e6', 'xs_contact', { look: '01', contactPlaceholder: 'بريدك', messagePlaceholder: 'رسالتك', quoteAuthor: 'عميل', formName: 'تواصل' }),
];
const BAND_WORDS = ['بيت هادي', 'تسوق', 'اكتشف', 'المنتجات', 'كل المنتجات', 'بحث', 'ابحث هنا', 'المزيد', 'عرض', 'افتح', 'سارة', 'مديرة التصميم', 'خبر', 'يوليو 2026', 'اقرأ المزيد', 'خامة ممتازة', 'شحن سريع', 'يوم', 'ساعة', 'دقيقة', 'ثانية', 'بريدك', 'رسالتك', 'عميل'];

const SHELL = {
  xsLook: '01',
  header: {
    announcement: { enabled: true, text: 'شحن مجاني', messages: ['شحن مجاني', 'خصم الموسم'] },
    menu: [{ label: 'الرئيسية', href: '/', kind: 'home', children: [{ label: 'وصل حديثا', href: '/new' }] }],
    zones: { links: [{ id: 'strip-0', type: 'link', label: 'حسابي', href: '/account' }, { id: 'strip-3', type: 'text', label: 'ج.م' }] },
    colors: { background: '#000000', text: '#ffffff' },
  },
  footer: {
    groups: [{ title: 'روابط', links: [{ label: 'من نحن', href: '/about', kind: 'page' }] }],
    text: 'متجر ملابس',
    columns: [{ id: 'contact', type: 'contact', title: 'تواصل معنا' }],
    bottom: [{ id: 'note', type: 'text', label: 'صنع في مصر' }],
  },
};
const SHELL_WORDS = ['شحن مجاني', 'خصم الموسم', 'الرئيسية', 'وصل حديثا', 'حسابي', 'ج.م', 'روابط', 'من نحن', 'متجر ملابس', 'تواصل معنا', 'صنع في مصر'];

async function setup() {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, 'Nile Store');
  const H = { Authorization: `Bearer ${auth.accessToken}` };
  const row = await db.Workspace.findByPk(workspace.id);
  await row.update({ settings: { ...(row.settings || {}), store_languages: ['en'] } });
  expect((await request(app).patch(`/api/v1/workspaces/${workspace.id}`).set(H).send({ themeSettings: SHELL })).status).toBe(200);

  const base = `/api/v1/workspaces/${workspace.id}/websites`;
  const site = await request(app).post(base).set(H).send({ name: 'Nile Store' });
  expect(site.status).toBe(201);
  const page = await request(app).post(`${base}/${site.body.website.id}/pages`).set(H).send({ path: '/', title: 'الرئيسية', draftData: tree(BANDS) });
  expect(page.status).toBe(201);
  expect((await request(app).post(`${base}/${site.body.website.id}/publish`).set(H).send({})).status).toBe(201);

  const content = (entityType) =>
    request(app).get(`/api/v1/workspaces/${workspace.id}/translations/content`).query({ entityType, locale: 'en' }).set(H);
  const save = (body) => request(app).put(`/api/v1/workspaces/${workspace.id}/translations/content`).set(H).send({ locale: 'en', ...body });
  const store = (locale) => {
    const req = request(app).get(`/api/v1/store/${workspace.id}`);
    return locale ? req.set('X-Store-Locale', locale) : req;
  };
  return { workspace, pageId: page.body.page.id, content, save, store };
}

const sources = (body) => body.items.flatMap((item) => item.texts.map((t) => t.source));

describe("an imported template's words to translate", () => {
  it("offers every word its bands show — not the form's name", async () => {
    const ctx = await setup();
    const res = await ctx.content('page');
    expect(res.status).toBe(200);
    const offered = sources(res.body);
    for (const word of BAND_WORDS) expect(offered).toContain(word);
    expect(offered).not.toContain('تواصل');
    expect(offered).not.toContain('/products');
  });

  it('offers the header and footer words — never their colours, links or ids', async () => {
    const ctx = await setup();
    const res = await ctx.content('shell');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ entityType: 'shell', entityId: ctx.workspace.id });
    expect(sources(res.body).sort()).toEqual([...new Set(SHELL_WORDS)].sort());
  });

  it("puts the header and footer in the shopper's language, leaving everything else as it was", async () => {
    const ctx = await setup();
    const english = { 'شحن مجاني': 'Free shipping', 'خصم الموسم': 'Season sale', 'الرئيسية': 'Home', 'وصل حديثا': 'New in', 'حسابي': 'My account', 'روابط': 'Links', 'من نحن': 'About us', 'متجر ملابس': 'A clothing store', 'تواصل معنا': 'Get in touch', 'صنع في مصر': 'Made in Egypt' };
    const texts = Object.fromEntries(Object.entries(english).map(([ar, en]) => [keyOf(ar), en]));
    const saved = await ctx.save({ entityType: 'shell', entityId: ctx.workspace.id, texts });
    expect(saved.status).toBe(200);

    const en = (await ctx.store('en')).body.store.themeSettings;
    expect(en.header.announcement).toMatchObject({ text: 'Free shipping', messages: ['Free shipping', 'Season sale'] });
    expect(en.header.menu[0]).toMatchObject({ label: 'Home', href: '/', children: [{ label: 'New in', href: '/new' }] });
    expect(en.header.zones.links.map((p) => p.label)).toEqual(['My account', 'ج.م']);
    expect(en.header.colors).toEqual(SHELL.header.colors);
    expect(en.footer).toMatchObject({ text: 'A clothing store', groups: [{ title: 'Links', links: [{ label: 'About us', href: '/about' }] }] });
    expect(en.footer.columns[0].title).toBe('Get in touch');
    expect(en.footer.bottom[0].label).toBe('Made in Egypt');

    // In Arabic, and with no language asked for, exactly as saved.
    expect((await ctx.store('ar')).body.store.themeSettings).toEqual(SHELL);
    expect((await ctx.store()).body.store.themeSettings).toEqual(SHELL);
  });

  it("puts the bands' new words in the shopper's language", async () => {
    const ctx = await setup();
    const texts = { [keyOf('كل المنتجات')]: 'All products', [keyOf('مديرة التصميم')]: 'Design lead', [keyOf('شحن سريع')]: 'Fast shipping' };
    expect((await ctx.save({ entityType: 'page', entityId: ctx.pageId, texts })).status).toBe(200);
    const home = await request(app).get(`/api/v1/store/${ctx.workspace.id}/pages`).set('X-Store-Locale', 'en');
    const elements = home.body.page.tree.sections[0].rows[0].columns[0].elements;
    expect(elements[1].props.allLabel).toBe('All products');
    expect(elements[2].props.items[0].role).toBe('Design lead');
    expect(elements[4].props.points).toEqual(['خامة ممتازة', 'Fast shipping']);
  });

  it("refuses a header and footer that are another store's", async () => {
    const ctx = await setup();
    const other = await ctx.save({ entityType: 'shell', entityId: '00000000-0000-4000-8000-000000000000', texts: { [keyOf('حسابي')]: 'My account' } });
    expect(other.status).toBe(404);
  });
});
