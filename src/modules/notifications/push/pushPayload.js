'use strict';

const { toDisplay } = require('../../../core/utils/money');

/**
 * What a device notification carries, built from an allowlist only.
 *
 * The push service sees when and how much is sent, and the device shows the
 * text on a locked screen, so nothing about a customer (name, phone, address,
 * what they wrote) ever goes in. The bell's own title, body and data are never
 * copied here: they may name the customer (merchantNotificationEvents.js).
 *
 *  - The payload has exactly the fields of FIELDS, and nothing else.
 *  - Its title and body come from TEXTS, one entry per type, filled only with
 *    the params that entry lists, each checked by its rule. Any other value a
 *    caller passes (a whole order, say) is ignored.
 *  - `url` is a path inside the app ("/orders/…"), never another site.
 *
 * Each type has `body` (one, with its details), `bare` (one, when the details
 * are not there: the order was deleted) and `many` ("5 new orders", when the
 * window gathered more than one). The title is the store's name, or Zimos.
 * A new type is one more entry in TEXTS, its params named with their rules.
 */

const FIELDS = ['v', 'type', 'title', 'body', 'url', 'tag', 'count'];

// Far under the 4096 bytes a push service carries once encrypted.
const MAX_BYTES = 3000;

const PARAM_RULES = {
  // A whole number, shown as it is (a count).
  integer: (value) => (Number.isSafeInteger(value) && value >= 0 ? String(value) : null),
  // An order's number as the store shows it ("1043", "ZM-1043").
  orderRef: (value) => {
    const text = typeof value === 'number' ? String(value) : value;
    return typeof text === 'string' && /^[A-Za-z0-9#_/-]{1,40}$/.test(text) ? text : null;
  },
  // { minor, currency }: an amount in minor units, shown as the bell shows it ("450.00 EGP").
  money: (value) => {
    if (!value || typeof value !== 'object') return null;
    const minor = typeof value.minor === 'string' && /^-?\d+$/.test(value.minor) ? Number(value.minor) : value.minor;
    if (!Number.isSafeInteger(minor) || typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)) return null;
    return `${toDisplay(minor)} ${value.currency}`;
  },
  // The store's own name: one line, no control characters, at most 60 characters.
  storeName: (value) => {
    if (typeof value !== 'string') return null;
    // eslint-disable-next-line no-control-regex
    const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 60);
    return text || null;
  },
  // A referral code as the console shows it ("RAMADAN10"): letters, digits, - and _.
  code: (value) => (typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : null),
};

const ORDER_PARAMS = { storeName: 'storeName', orderNumber: 'orderRef', amount: 'money', count: 'integer' };
const COUNT_PARAMS = { storeName: 'storeName', count: 'integer' };
const STORE_TITLE = { title: '{storeName}' };

/** A type whose only detail is how many: the same sentence for one, and a count for more. */
const counted = (ar, arMany, en, enMany) => ({
  params: COUNT_PARAMS,
  ar: { ...STORE_TITLE, body: ar, bare: ar, many: arMany },
  en: { ...STORE_TITLE, body: en, bare: en, many: enMany },
});

/**
 * The console's (platformAdmin/consolePush.js): one per bell type, "console." and
 * the type, a decided review by its decision. Never a merchant's or a store's
 * name, an email or a reviewer's reason: the bell's own words open the page.
 */
const consoleText = (ar, en, { params = {}, bareAr = ar, bareEn = en } = {}) => ({
  params,
  ar: { title: 'Zimos', body: ar, bare: bareAr },
  en: { title: 'Zimos', body: en, bare: bareEn },
});
const CODE = { code: 'code' };
const CONSOLE_TEXTS = {
  'console.user_signup': consoleText('تسجيل جديد على المنصة', 'A new sign-up on the platform'),
  'console.workspace_created': consoleText('أُنشئ متجر جديد', 'A new store was created'),
  'console.subscription_activated': consoleText('تم تفعيل اشتراك', 'A subscription was activated'),
  'console.subscription_expiring': consoleText('اشتراك ينتهي خلال 7 أيام', 'A subscription ends within 7 days'),
  'console.subscription_expired': consoleText('انتهى اشتراك', 'A subscription ended'),
  'console.payment_proof_submitted': consoleText('إثبات دفع جديد بانتظار المراجعة', 'A new payment proof is waiting for review'),
  'console.payment_failed': consoleText('فشل دفع اشتراك', 'A subscription payment failed'),
  'console.support_ticket': consoleText('تذكرة دعم جديدة', 'A new support ticket'),
  'console.referral_signup': consoleText('متجر استخدم الكود {code}', 'A store used the code {code}', {
    params: CODE,
    bareAr: 'متجر استخدم كود إحالة',
    bareEn: 'A store used a referral code',
  }),
  'console.user_suspended': consoleText('تم إيقاف حساب', 'An account was suspended'),
  'console.suggestion': consoleText('اقتراح جديد من تاجر', 'A new suggestion from a merchant'),
  'console.wallet_fallback': consoleText('متجر انتقل إلى الدفع لكل طلب', 'A store moved to pay per order'),
  'console.traffic_cap': consoleText('متجر تجاوز حده اليومي من بيانات الزيارات', 'A store went over its daily analytics limit'),
  'console.sms_cap': consoleText('بلوغ الحد اليومي للرسائل النصية', 'The daily SMS cap was reached'),
  'console.referral_code_review': consoleText('الكود {code} بانتظار المراجعة', 'Code {code} is waiting for review', {
    params: CODE,
    bareAr: 'كود إحالة بانتظار المراجعة',
    bareEn: 'A referral code is waiting for review',
  }),
  'console.referral_code_approved': consoleText('تمت الموافقة على الكود {code}', 'Code {code} was approved', {
    params: CODE,
    bareAr: 'تمت الموافقة على كود إحالة',
    bareEn: 'A referral code was approved',
  }),
  'console.referral_code_rejected': consoleText('رُفض الكود {code}', 'Code {code} was rejected', {
    params: CODE,
    bareAr: 'رُفض كود إحالة',
    bareEn: 'A referral code was rejected',
  }),
  'console.referral_change_approved': consoleText('تمت الموافقة على تعديل الكود {code}', 'The change to code {code} was approved', {
    params: CODE,
    bareAr: 'تمت الموافقة على تعديل كود إحالة',
    bareEn: 'A change to a referral code was approved',
  }),
  'console.referral_change_rejected': consoleText('رُفض تعديل الكود {code}', 'The change to code {code} was rejected', {
    params: CODE,
    bareAr: 'رُفض تعديل كود إحالة',
    bareEn: 'A change to a referral code was rejected',
  }),
  'console.agent_link_review': consoleText('تعديل وكيل متجر بانتظار المراجعة', 'A store agent change is waiting for review'),
  'console.agent_link_approved': consoleText('تمت الموافقة على تعديل وكيل متجر', 'A store agent change was approved'),
  'console.agent_link_rejected': consoleText('رُفض تعديل وكيل متجر', 'A store agent change was rejected'),
};

// The dashboard's Arabic is Modern Standard Arabic. "{label}: {count}" keeps
// the Arabic count out of number agreement.
const TEXTS = {
  'push.test': {
    params: {},
    ar: { title: 'Zimos', body: 'هذا إشعار تجريبي: إشعارات الجهاز تعمل.' },
    en: { title: 'Zimos', body: 'This is a test notification: device notifications work.' },
  },
  'order.new': {
    params: ORDER_PARAMS,
    ar: { ...STORE_TITLE, body: 'طلب جديد {orderNumber} بقيمة {amount}', bare: 'طلب جديد', many: 'طلبات جديدة: {count}' },
    en: { ...STORE_TITLE, body: 'New order {orderNumber} for {amount}', bare: 'A new order', many: '{count} new orders' },
  },
  'order.paid': {
    params: ORDER_PARAMS,
    ar: { ...STORE_TITLE, body: 'تم دفع الطلب {orderNumber} ({amount})', bare: 'تم دفع طلب', many: 'طلبات مدفوعة: {count}' },
    en: { ...STORE_TITLE, body: 'Order {orderNumber} was paid ({amount})', bare: 'An order was paid', many: '{count} orders were paid' },
  },
  'order.suspicious': {
    params: ORDER_PARAMS,
    ar: { ...STORE_TITLE, body: 'طلب يحتاج إلى مراجعة: {orderNumber}', bare: 'طلب يحتاج إلى مراجعة', many: 'طلبات تحتاج إلى مراجعة: {count}' },
    en: { ...STORE_TITLE, body: 'Order {orderNumber} needs a review', bare: 'An order needs a review', many: '{count} orders need a review' },
  },
  'lost_order.new': counted('طلب مفقود جديد', 'طلبات مفقودة جديدة: {count}', 'A new lost order', '{count} new lost orders'),
  'whatsapp.message': counted('رسالة واتساب جديدة', 'رسائل واتساب جديدة: {count}', 'A new WhatsApp message', '{count} new WhatsApp messages'),
  'stock.low': counted('منتج قارب على النفاد', 'منتجات قاربت على النفاد: {count}', 'A product is running low', '{count} products are running low'),
  'integration.failed': counted(
    'تعذّر الاتصال بإحدى الخدمات المتصلة',
    'خدمات متصلة تعذّر الاتصال بها: {count}',
    'A connected service stopped working',
    '{count} connected services stopped working'
  ),
  'export.ready': counted('ملف التصدير جاهز', 'ملفات تصدير جاهزة: {count}', 'Your export is ready', '{count} exports are ready'),
  'shipping.batch_done': counted('اكتمل الشحن الجماعي', 'دفعات شحن اكتملت: {count}', 'A bulk shipment finished', '{count} bulk shipments finished'),
  automation: counted('تنبيه من الأتمتة', 'تنبيهات من الأتمتة: {count}', 'An automation alert', '{count} automation alerts'),
  'wallet.low': counted('رصيد المحفظة منخفض', 'تنبيهات رصيد المحفظة: {count}', 'Your wallet balance is low', '{count} wallet balance alerts'),
  'wallet.limit_reached': counted('وصل رصيد المحفظة إلى الحد', 'تنبيهات حد المحفظة: {count}', 'Your wallet reached its limit', '{count} wallet limit alerts'),
  'wallet.refund': counted('تحديث على طلب استرداد الرصيد', 'تحديثات على طلبات الاسترداد: {count}', 'An update on a refund request', '{count} updates on refund requests'),
  'wallet.credit': counted('أُضيف رصيد إلى محفظتك', 'إضافات إلى رصيد المحفظة: {count}', 'Credit was added to your wallet', '{count} credits were added to your wallet'),
  'wallet.fallback': counted('انتهى الاشتراك، والدفع الآن لكل طلب', 'تنبيهات الاشتراك: {count}', 'Your subscription ended: you now pay per order', '{count} subscription alerts'),
  'product.question': counted('سؤال جديد على منتج', 'أسئلة جديدة على المنتجات: {count}', 'A new question on a product', '{count} new questions on products'),
  'review.new': counted('تقييم جديد في انتظار موافقتك', 'تقييمات في انتظار موافقتك: {count}', 'A new review is waiting for your approval', '{count} reviews are waiting for your approval'),
  'message.undelivered': counted('رسالة إلى عميل لم تصل', 'رسائل لم تصل: {count}', 'A message to a customer was not delivered', '{count} messages were not delivered'),
  ...CONSOLE_TEXTS,
};

const LOCALES = ['ar', 'en'];

/** The template filled with its params; null when one is missing or not allowed. */
function fill(template, params, rules) {
  let missing = false;
  const text = template.replace(/\{(\w+)\}/g, (match, name) => {
    const rule = rules[name] && PARAM_RULES[rules[name]];
    const value = rule ? rule(params[name]) : null;
    if (value === null) missing = true;
    return value === null ? '' : value;
  });
  return missing ? null : text;
}

// A path inside the app: one leading slash, no scheme, no host, no backslash.
const SAFE_PATH = /^\/(?![/\\])[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/;
const SAFE_TAG = /^[A-Za-z0-9:._-]{1,64}$/;

/**
 * The JSON string sent to the device. `type` must be one of TEXTS; `params`
 * is read only for the names TEXTS lists for it. `count` over 1 picks the
 * "many" text.
 */
function build(type, { locale, params = {}, url = '/', tag, count = 1 } = {}) {
  const text = TEXTS[type];
  if (!text) throw new Error(`Unknown push type "${type}"`);
  const words = text[LOCALES.includes(locale) ? locale : 'ar'];
  const safeCount = Number.isSafeInteger(count) && count >= 1 && count <= 999 ? count : 1;
  const safeParams = { ...(params && typeof params === 'object' ? params : {}), count: safeCount };
  const body =
    (safeCount > 1 && words.many ? fill(words.many, safeParams, text.params) : fill(words.body, safeParams, text.params)) ??
    (words.bare !== undefined ? words.bare : null);
  if (body === null) throw new Error(`Push text of "${type}" is missing a param`);
  const payload = {
    v: 1,
    type,
    title: fill(words.title, safeParams, text.params) || 'Zimos',
    body,
    url: typeof url === 'string' && url.length <= 300 && SAFE_PATH.test(url) ? url : '/',
    tag: typeof tag === 'string' && SAFE_TAG.test(tag) ? tag : type,
    count: safeCount,
  };
  const json = JSON.stringify(payload, FIELDS);
  if (Buffer.byteLength(json) > MAX_BYTES) throw new Error(`Push payload of "${type}" is over ${MAX_BYTES} bytes`);
  return json;
}

module.exports = { build, FIELDS, TEXTS, MAX_BYTES };
