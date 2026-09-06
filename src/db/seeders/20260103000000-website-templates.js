'use strict';

/**
 * Five ready-made website templates for the merchant "pick a template" screen.
 * Each has one active version whose `pages` array holds a real home page (a
 * few sections with content), deep-copied into the merchant's website when
 * they choose it. Default `primaryColor` for all five is a shade of blue —
 * the platform's primary colour.
 */

// Fixed ids so `down` is exact and re-running is predictable.
const T = {
  minimal: 'a0000000-0000-4000-8000-000000000001',
  fashion: 'a0000000-0000-4000-8000-000000000002',
  electronics: 'a0000000-0000-4000-8000-000000000003',
  food: 'a0000000-0000-4000-8000-000000000004',
  funnel: 'a0000000-0000-4000-8000-000000000005',
};
const V = {
  minimal: 'b0000000-0000-4000-8000-000000000001',
  fashion: 'b0000000-0000-4000-8000-000000000002',
  electronics: 'b0000000-0000-4000-8000-000000000003',
  food: 'b0000000-0000-4000-8000-000000000004',
  funnel: 'b0000000-0000-4000-8000-000000000005',
};

// --- tiny page-tree builders (shape enforced by pages/pageTree.js) ---------
const el = (id, type, props = {}) => ({ id, type, props });
const column = (id, elements, span = 12) => ({ id, type: 'column', span, elements });
const row = (id, columns) => ({ id, type: 'row', columns });
const section = (id, rows) => ({ id, type: 'section', rows });
const oneCol = (id, elements) => section(id, [row(`${id}-r`, [column(`${id}-c`, elements)])]);

const heroSection = (title, subtitle, cta) =>
  oneCol('hero', [
    el('hero-h', 'heading', { text: title, level: 1 }),
    el('hero-p', 'text', { text: subtitle }),
    el('hero-btn', 'button', { label: cta, href: '/products', variant: 'primary' }),
  ]);

const productListSection = (title) =>
  oneCol('products', [el('products-e', 'product_list', { title, source: 'newest', limit: 8, columns: 4 })]);

const productCardSection = (title) =>
  oneCol('offer', [el('offer-e', 'product_card', { title, showPrice: true, showBuyButton: true })]);

const gallerySection = (title) =>
  oneCol('gallery', [el('gallery-e', 'gallery', { title, images: [], columns: 3 })]);

const testimonialSection = (quote, author) =>
  oneCol('testimonial', [el('testimonial-e', 'testimonial', { quote, author, rating: 5 })]);

const faqSection = (items) => oneCol('faq', [el('faq-e', 'faq', { title: 'الأسئلة الشائعة', items })]);

const countdownSection = (label) =>
  oneCol('countdown', [el('countdown-e', 'countdown', { label, endsInHours: 24 })]);

const homePage = (sections) => ({
  path: '/',
  title: 'الرئيسية',
  pageType: 'home',
  builderData: { version: 1, sections },
  seo: {},
});

const styles = (primaryColor) => ({
  primaryColor,
  fontFamily: 'Cairo, system-ui, -apple-system, sans-serif',
  mode: 'light',
});

const TEMPLATES = [
  {
    id: T.minimal,
    versionId: V.minimal,
    name: 'بسيط ومينيمال',
    category: 'general',
    thumbnailUrl: 'https://media.zimos.co/templates/minimal.png',
    globalStyles: styles('#2563EB'),
    pages: [
      homePage([
        heroSection('متجرك الأنيق يبدأ من هنا', 'تصميم نظيف يركّز على منتجاتك بدون تشتيت.', 'ابدأ التسوّق'),
        productListSection('وصل حديثًا'),
        testimonialSection('تجربة شراء سلسة وسريعة، هرجع أطلب أكيد.', 'منى ع.'),
      ]),
    ],
  },
  {
    id: T.fashion,
    versionId: V.fashion,
    name: 'أزياء وموضة',
    category: 'fashion',
    thumbnailUrl: 'https://media.zimos.co/templates/fashion.png',
    globalStyles: styles('#1D4ED8'),
    pages: [
      homePage([
        heroSection('كولكشن الموسم الجديد', 'قطع مختارة بعناية لإطلالة مميزة كل يوم.', 'تسوّقي الآن'),
        gallerySection('لوك بوك'),
        productListSection('الأكثر مبيعًا'),
        testimonialSection('الخامات ممتازة والمقاسات مضبوطة.', 'سارة ح.'),
      ]),
    ],
  },
  {
    id: T.electronics,
    versionId: V.electronics,
    name: 'إلكترونيات وأجهزة',
    category: 'electronics',
    thumbnailUrl: 'https://media.zimos.co/templates/electronics.png',
    globalStyles: styles('#1E40AF'),
    pages: [
      homePage([
        heroSection('أحدث الأجهزة بأفضل الأسعار', 'ضمان رسمي وشحن سريع لكل الطلبات.', 'اكتشف العروض'),
        productListSection('عروض هذا الأسبوع'),
        faqSection([
          { q: 'هل يوجد ضمان؟', a: 'نعم، ضمان رسمي سنة على كل الأجهزة.' },
          { q: 'كم يستغرق الشحن؟', a: 'من 2 إلى 4 أيام عمل داخل المحافظات.' },
        ]),
        testimonialSection('وصل الجهاز أسرع مما توقّعت وبحالة ممتازة.', 'أحمد ر.'),
      ]),
    ],
  },
  {
    id: T.food,
    versionId: V.food,
    name: 'أكل ومشروبات',
    category: 'food_beverage',
    thumbnailUrl: 'https://media.zimos.co/templates/food.png',
    globalStyles: styles('#0EA5E9'),
    pages: [
      homePage([
        heroSection('طازة كل يوم، لحد باب البيت', 'اطلب وجباتك ومشروباتك المفضّلة في دقائق.', 'اطلب الآن'),
        productListSection('الأطباق المميزة'),
        testimonialSection('الطعم رهيب والتوصيل كان في الميعاد بالظبط.', 'ياسمين ط.'),
        faqSection([{ q: 'ما هي مناطق التوصيل؟', a: 'نغطّي القاهرة الكبرى حاليًا مع توسّع قريب.' }]),
      ]),
    ],
  },
  {
    id: T.funnel,
    versionId: V.funnel,
    name: 'منتج واحد — فانل بيع سريع',
    category: 'single_product',
    thumbnailUrl: 'https://media.zimos.co/templates/funnel.png',
    globalStyles: styles('#3B82F6'),
    pages: [
      homePage([
        heroSection('المنتج اللي هيغيّر يومك', 'عرض لفترة محدودة — اطلب دلوقتي قبل نفاد الكمية.', 'اطلب الآن'),
        countdownSection('ينتهي العرض خلال'),
        productCardSection('باقة العرض الخاصة'),
        testimonialSection('استخدمته أسبوع وفرق معايا فعلاً. يستاهل.', 'كريم س.'),
        faqSection([{ q: 'هل الدفع عند الاستلام متاح؟', a: 'نعم، الدفع كاش عند الاستلام متاح لكل الطلبات.' }]),
      ]),
    ],
  },
];

module.exports = {
  up: async (queryInterface) => {
    const now = new Date();

    await queryInterface.bulkInsert(
      'templates',
      TEMPLATES.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        thumbnail_url: t.thumbnailUrl,
        is_published: true,
        created_at: now,
        updated_at: now,
      }))
    );

    await queryInterface.bulkInsert(
      'template_versions',
      TEMPLATES.map((t) => ({
        id: t.versionId,
        template_id: t.id,
        version: 1,
        global_styles: JSON.stringify(t.globalStyles),
        pages: JSON.stringify(t.pages),
        sections: JSON.stringify([]),
        is_active: true,
        created_at: now,
        updated_at: now,
      }))
    );
  },

  down: async (queryInterface, Sequelize) => {
    const ids = TEMPLATES.map((t) => t.id);
    await queryInterface.bulkDelete('template_versions', { template_id: { [Sequelize.Op.in]: ids } });
    await queryInterface.bulkDelete('templates', { id: { [Sequelize.Op.in]: ids } });
  },
};
