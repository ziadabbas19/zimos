# ربط متجرك على Zimos بـ Zapier وMake وn8n وGoogle Sheets

دليل قصير للتاجر: كيف تصل طلباتك المؤكدة إلى جدول بيانات أو نظام آخر دون كتابة
كود، أو بسطور قليلة في Google Apps Script. التفاصيل التقنية الكاملة في
`docs/public-api.md`.

## ماذا يُرسل Zimos

عند كل حدث تختاره يرسل Zimos طلب `POST` موقّعًا إلى رابط تحدده. أهم حدث للحسابات
والمطابخ هو **`order.accepted`**: يُرسل مرة واحدة لكل طلب عندما يصبح مؤكدًا:

- طلب الدفع عند الاستلام (أو التحويل اليدوي) عند تأكيده.
- الطلب المدفوع أونلاين عند الدفع.
- الطلب الملغي لا يُرسل.

`order.accepted` لا يدخل ضمن «كل الأحداث»: اختره بالاسم (يمكنك اختياره مع «كل
الأحداث»).

الحقول التي تحتاجها غالبًا في الطلب (`data.order`):

| الحقل | المعنى |
|---|---|
| `id` في أعلى الطلب | معرّف الحدث، ثابت عند إعادة المحاولة. استخدمه لتجاهل التكرار |
| `data.order.orderNumber` | رقم الطلب |
| `data.acceptedAt` | وقت التأكيد |
| `data.order.contact.fullName` و`phone` | العميل وهاتفه |
| `data.order.shippingAddress` | العنوان (`province` و`city` و`addressLine`) |
| `data.order.items[]` | البنود: `name` و`quantity` و`unitPrice` و`lineTotal` |
| `data.order.amounts` | `shipping` و`discount` و`total` |
| `data.order.paymentMethod` و`financialState` | طريقة الدفع وحالته |

**المبالغ بالقرش (الوحدة الصغرى):** `30100` تعني 301.00 جنيه. اقسم على 100.

**البيانات الشخصية:** الطلب يحمل اسم العميل وهاتفه وعنوانه كاملة. لا تضع الرابط في
مكان عام، ولا تشارك الجدول إلا مع من يحتاجه.

## الطريقة العامة (لأي أداة)

1. أنشئ في الأداة «Webhook» يستقبل طلبات POST وانسخ رابطه.
2. في Zimos: **الإعدادات ← المطورون ← Webhooks ← إضافة رابط**. الصق الرابط واختر
   `order.accepted`.
3. انسخ **مفتاح التوقيع** (`whsec_…`) واحفظه إن كانت الأداة تستطيع التحقق منه.
4. اضغط **إرسال تجربة**، ثم أكّد طلبًا تجريبيًا ليصل حدث حقيقي.
5. في الأداة: اربط الحقول بأعمدة الجدول.

يجب أن يرد الرابط بـ **2xx خلال 10 ثوانٍ**. أي رد آخر (خطأ، مهلة، أو **تحويل 3xx**)
يُعاد إرساله حتى 8 مرات على مدى يومين تقريبًا، وإذا استمر الفشل وحده 3 أيام يُوقَف
الرابط تلقائيًا ويصلك إشعار.

## Zapier

1. **Create Zap** ← المشغّل: **Webhooks by Zapier** ← **Catch Hook** ← انسخ الرابط.
2. أضف الرابط في Zimos واختر `order.accepted`، ثم **إرسال تجربة** ثم أكّد طلبًا.
3. في Zapier: **Test trigger** واختر الحدث الحقيقي (ليس `webhook.test`).
4. أضف خطوة **Filter**: `type` يساوي `order.accepted`.
5. أضف **Google Sheets ← Create Spreadsheet Row** واربط الأعمدة بالحقول أعلاه.

Zapier لا يتحقق من التوقيع في Catch Hook. اعتبر الرابط سرًا، وإذا تسرّب احذفه وأنشئ
غيره.

## Make

1. **Create a new scenario** ← **Webhooks ← Custom webhook** ← **Add** ← انسخ الرابط.
2. أضفه في Zimos، ثم أكّد طلبًا ليتعرّف Make على شكل البيانات (**Redetermine data structure**).
3. أضف **Filter** على `type = order.accepted`، ثم **Google Sheets ← Add a Row**.

## n8n

1. أضف عقدة **Webhook** بطريقة **POST**، وانسخ **Production URL** بعد تفعيل الـ workflow.
2. يستطيع n8n قراءة الـ headers، لذلك تحقق من التوقيع بعقدة **Code** قبل أي خطوة.
   ضع المفتاح في متغير بيئة `ZIMOS_WEBHOOK_SECRET` لدى n8n، وفعّل في عقدة
   Webhook خيار **Raw Body** حتى يصل النص كما أُرسل:

```js
// عقدة Code (Run Once for Each Item)
const crypto = require('crypto');
const secret = $env.ZIMOS_WEBHOOK_SECRET;
const header = $json.headers['x-zimos-signature'] || '';
const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
const raw = Buffer.from($binary.data.data, 'base64').toString('utf8'); // النص كما وصل
const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${raw}`).digest('hex');
const fresh = Math.abs(Date.now() / 1000 - Number(parts.t)) < 300;
if (!fresh || !parts.v1 || expected.length !== parts.v1.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1))) {
  throw new Error('توقيع غير صحيح');
}
return { json: JSON.parse(raw) };
```

3. بعدها **IF** على `type = order.accepted`، ثم **Google Sheets ← Append**.

## Google Apps Script مباشرة

### تنبيهان قبل البدء

1. **Apps Script لا يقرأ الـ headers**، فلا يستطيع التحقق من توقيع Zimos. البديل:
   **توكن سري طويل في الرابط** (`?token=…`) يقارنه السكربت بقيمة محفوظة عنده.
   الرابط بالتوكن يظهر في شاشة المطورين وسجل الإرسال لمن يملك صلاحيتها، فعامله
   كسر، وغيّر التوكن إذا تسرّب. (لا يمكن وضع التوكن في جسم الطلب: Zimos يرسل الطلب
   كما هو.)
2. **Apps Script يرد على كل POST بتحويل 302**، وZimos لا يتبع التحويلات ويعدّ الرد
   فشلًا، رغم أن السكربت نُفّذ وأضاف الصف. النتيجة:
   - يُعاد الإرسال، فلا بد أن يتجاهل السكربت الحدث المكرر بمعرّفه (المثال أدناه يفعل ذلك).
   - يظهر الإرسال «فاشلًا» في السجل، وبعد 3 أيام من «الفشل» يُوقَف الرابط تلقائيًا.

   لذلك **نوصي** بـ Zapier أو Make أو n8n بين Zimos والجدول، أو بطريقة السحب في
   آخر هذا الدليل. استخدم الطريقة المباشرة للتجربة فقط.

### الخطوات

1. افتح الجدول ← **Extensions ← Apps Script** والصق الكود التالي.
2. **Project Settings ← Script Properties**: أضف `ZIMOS_TOKEN` بقيمة عشوائية طويلة
   (40 حرفًا أو أكثر).
3. **Deploy ← New deployment ← Web app**: Execute as: **Me**، Who has access: **Anyone**.
   انسخ الرابط.
4. في Zimos أضف الرابط وفي آخره `?token=` ثم القيمة نفسها، واختر `order.accepted`.

```js
const SHEET_NAME = 'Orders';
const HEADERS = ['Event id', 'Order', 'Accepted at', 'Customer', 'Phone', 'Address', 'Items', 'Shipping', 'Discount', 'Total', 'Currency', 'Payment', 'Payment state'];

function doPost(e) {
  const token = PropertiesService.getScriptProperties().getProperty('ZIMOS_TOKEN');
  if (!token || !e || !e.parameter || e.parameter.token !== token) return text('forbidden');
  const event = JSON.parse(e.postData.contents);
  if (event.type !== 'order.accepted') return text('ignored');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const book = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = book.getSheetByName(SHEET_NAME) || book.insertSheet(SHEET_NAME);
    if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
    // إعادة المحاولة تحمل نفس معرّف الحدث: لا نكتب الصف مرتين.
    const last = sheet.getLastRow();
    const seen = last > 1 ? sheet.getRange(2, 1, last - 1, 1).getValues().map((r) => r[0]) : [];
    if (seen.indexOf(event.id) !== -1) return text('duplicate');

    const o = event.data.order;
    const a = o.shippingAddress || {};
    const money = (minor) => (minor == null ? '' : minor / 100);
    sheet.appendRow([
      event.id,
      safe(o.orderNumber),
      event.data.acceptedAt,
      safe(o.contact && o.contact.fullName),
      safe(o.contact && o.contact.phone),
      safe([a.province, a.city, a.addressLine].filter(String).join(' - ')),
      safe(o.items.map((i) => i.quantity + ' x ' + i.name + ' = ' + money(i.lineTotal)).join(' | ')),
      money(o.amounts.shipping),
      money(o.amounts.discount),
      money(o.amounts.total),
      o.currency,
      o.paymentMethod,
      o.financialState,
    ]);
  } finally {
    lock.releaseLock();
  }
  return text('ok');
}

// Google Sheets يعامل نصًا يبدأ بـ = أو + أو - أو @ كمعادلة: العميل يكتب ما يشاء في اسمه وعنوانه.
function safe(value) {
  const s = value == null ? '' : String(value);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function text(body) {
  return ContentService.createTextOutput(body);
}
```

## طريقة السحب من Apps Script (عند توفر «الطلبات المؤكدة» في الـ API)

بدل أن يرسل Zimos إلى السكربت، يسأل السكربت Zimos كل بضع دقائق عن الطلبات المؤكدة
الجديدة ثم يؤكد استلامها. لا تحويلات ولا توقيع: الاتصال عبر HTTPS بمفتاح API، و
Apps Script يستطيع إرسال الـ headers.

1. في Zimos: **المطورون ← مفاتيح API ← مفتاح جديد** بصلاحية **قراءة الطلبات**.
2. في Script Properties: `ZIMOS_API_KEY` = المفتاح، و`ZIMOS_API_BASE` =
   `https://<عنوان الـ API>/api/v1/public`.
3. **Triggers ← Add Trigger**: الدالة `pullAccepted`، **Time-driven**، كل 5 دقائق.

```js
function pullAccepted() {
  const props = PropertiesService.getScriptProperties();
  const base = props.getProperty('ZIMOS_API_BASE');
  const headers = { Authorization: 'Bearer ' + props.getProperty('ZIMOS_API_KEY') };
  const res = UrlFetchApp.fetch(base + '/orders/accepted?limit=100', { headers: headers, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Zimos: ' + res.getResponseCode());
  const orders = JSON.parse(res.getContentText()).orders;
  if (orders.length === 0) return;

  const book = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = book.getSheetByName('Orders') || book.insertSheet('Orders');
  if (sheet.getLastRow() === 0) sheet.appendRow(['Order id', 'Order', 'Accepted at', 'Customer', 'Items', 'Total', 'Payment']);
  const money = (minor) => (minor == null ? '' : minor / 100);
  orders.forEach((o) => {
    sheet.appendRow([
      o.id,
      safe(o.orderNumber),
      o.acceptedAt,
      safe(o.contact && o.contact.fullName),
      safe(o.items.map((i) => i.quantity + ' x ' + i.name).join(' | ')),
      money(o.amounts.total),
      o.paymentMethod,
    ]);
  });
  // تأكيد الاستلام بعد الكتابة: ما لم يُؤكَّد يُعرض مرة أخرى في السحب التالي.
  UrlFetchApp.fetch(base + '/orders/ack', {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify({ orderIds: orders.map((o) => o.id) }),
  });
}

function safe(value) {
  const s = value == null ? '' : String(value);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
```

أرقام الهواتف تظهر في هذا السحب مخفية جزئيًا (إلا إذا أعطيت المفتاح صلاحية العملاء
وكان منشئ المفتاح يملك رؤية الأرقام كاملة). هذا للتسهيل فقط وليس حماية: المفتاح نفسه
يقرأ الطلب الواحد بالرقم كاملًا، والاسم والعنوان والبريد لا تُخفى أبدًا. ما يقرؤه المفتاح
تحدده صلاحياته ودور من أنشأه، فلا تعطِ مفتاح الجدول أكثر مما يحتاج.
