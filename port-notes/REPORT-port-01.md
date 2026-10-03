# تقرير الدفعة 01 — الرئيسية، المبيعات حسب UTM، تصدير الطلبات CSV

الحالة: **خلصت** (بدون أي migration). مرجع القراءة: فرع `zimos-additions` عند مصطفى
(الباك `9a11f28`، الفرونت `37853f3`) — قراءة فقط، لا نسخ ولا cherry-pick.

## الفروع

| الريبو | الفرع | خرج من |
|---|---|---|
| zimos | `feat/port-01-home-utm-export` | `main` @ `42b5b53` |
| zimos-frontend | `feat/port-01-home-utm-export` | `main` @ `2821b81` |

كوميتات الكود (رأس كل فرع هو كوميت `docs(port)` اللي بيضيف التقرير ده):

- zimos: `4aa33bf` refactor(orders) · `0acaae4` feat(analytics) · `de10501` feat(orders) · `f8238df` docs(api) · `58eba34` fix(analytics) · `28b1613` perf(analytics)
- zimos-frontend: `11865ea` feat(api-client) · `75ace62` feat(dashboard) home · `dee0a8f` feat(dashboard) UTM · `b9890e0` feat(dashboard) export · `a19c852` fix(dashboard)

## اللي اتعمل

### الباك (zimos)

| Endpoint | السلسلة | الصلاحية |
|---|---|---|
| `GET /api/v1/workspaces/:id/analytics/overview` | authenticate → resolveTenant → requirePermission | `analytics.view` |
| `GET /api/v1/workspaces/:id/analytics/utm` | authenticate → resolveTenant → requirePermission | `analytics.view` |
| `GET /api/v1/workspaces/:id/orders/export/columns` | authenticate → resolveTenant → requirePermission ×2 | `orders.view` + `orders.export` |
| `GET /api/v1/workspaces/:id/orders/export` | authenticate → resolveTenant → requirePermission ×2 | `orders.view` + `orders.export` (+ `customers.reveal_sensitive` لأعمدة التواصل) |

- **الرئيسية** (`overviewService.js`): كل أرقام الفترة والفترة اللي قبلها بنفس الطول، وسلسلة يومية لكل فترة، وأكثر المنتجات مبيعًا. كله `GROUP BY GROUPING SETS` في Postgres — مفيش تحميل صفوف في Node. cache قصير في الذاكرة: 60 ثانية، مفتاحه المتجر + الفترة + المقارنة، حد أقصى 500 مدخل، والفشل لا يُخزَّن، والطلبات المتزامنة لنفس المفتاح تشارك حساب واحد.
- **المبيعات حسب UTM** (`utmReportService.js`): زوار، طلبات، مبيعات، مؤكد، متسلّم، مبيعات متسلّمة، تحويل، متوسط الطلب لكل قيمة `source|medium|campaign|content|term`، مع drill-down بـ `source/medium/campaign`. كل طلب في صف واحد بس: قيمة، أو «مباشر» (اتتبع بدون وسم)، أو «غير متتبَّع» (مالوش حدث شراء) — فالصفوف بتجمع للمبيعات الحقيقية.
- **التصدير** (`orderExportService.js`): نفس فلاتر قائمة الطلبات وترتيبها بالظبط (استخرجت `orderListConditions` من `listOrders` بدون تغيير سلوكها)، صف لكل طلب أو لكل منتج، عربي أو إنجليزي، تواريخ بتوقيت المتجر، فلوس بـ `money.toDisplay`. stream على صفحات 500 بـ keyset مع backpressure، وأي خطأ بعد بداية الملف بيقطع الاتصال بدل ملف ناقص بصمت.
- صلاحية جديدة في `permissions.js`: `orders.export`.
- `docs/openapi.json`: اتوثقت الأربع endpoints.

### الفرونت (zimos-frontend)

- `packages/api-client/src/endpoints/reports.ts` و `orderExport.ts` (ملفات جديدة؛ `client.ts` و `types.ts` ما اتلمسوش).
- **الرئيسية**: طلب واحد بدل طلبين `summary`؛ مبدّل الفترة؛ المبيعات/الطلبات/متوسط الطلب/التحويل مع نسبة التغيّر؛ المبيعات اليومية مقابل الفترة السابقة؛ «أرقام أخرى» بقيمة الفترة السابقة؛ قائمة التأكيد وأحدث الطلبات وأكثر المنتجات ومسارات البيع. فترة فاضية = empty state بنص واضح بدل رسم أصفار، وفشل = رسالة + «حاول مرة أخرى»، ودور بدون `analytics.view` = نفس الملخص القديم.
- **صفحة «المبيعات حسب المصدر»** `/analytics/utm` + عنصر في الشريط الجانبي تحت «التقارير» (مخفي عن الأدوار اللي ما عندهاش `analytics.view`).
- **زر «تصدير CSV»** في قائمة الطلبات + نافذة: شكل الصف، لغة الملف، الأعمدة من كتالوج السيرفر (أعمدة التواصل مقفولة بقفل لو مفيش صلاحية)، ورسالة واضحة لو التصدير أكبر من الحد. الزر مخفي عن أدوار النظام اللي ما عندهاش `orders.export`.
- `RangeSwitch` بقى ياخد `compare={false}` لشاشة مش بتقارن فترات.
- كل النصوص بـ `useT({en, ar})`، أصناف منطقية (`ms-/me-/ps-/pe-/start-/end-/text-start/text-end`)، أرقام داخل `<bdi dir="ltr">`.

## قواعد النقل — التحقق

| القاعدة | النتيجة |
|---|---|
| authenticate ثم resolveTenant ثم صلاحية صريحة | ✓ في كل route (الجدول فوق) |
| ممنوع findByPk من غير workspaceId | ✓ — المتجر نفسه بـ `findOne({ where: { id: workspaceId } })`؛ بنود الطلب بـ JOIN على `orders.workspace_id`؛ الشحنات بـ `workspace_id` |
| التقارير أرقام مجمّعة | ✓ |
| كل mutation فيها recordAudit | الدفعة قراءة بس؛ ومع ذلك كل تصدير بيتسجّل `order.export` (عدد الصفوف، الأعمدة، أعمدة التواصل، الفلاتر — من غير نص البحث نفسه) |
| ممنوع req.ip | ✓ — مفيش `req.ip` في الإضافات؛ الـ audit بيستخدم `clientIp(req)` |
| الفلوس minor units عن طريق money.js | ✓ — `assertInt` للمجاميع، `toDisplay` في CSV، ومتوسط الطلب `round(avg())` في SQL |
| الأسرار | لا أسرار جديدة ولا متغيرات بيئة جديدة |
| migrations | **لا يوجد** (الرقم الجاي لسه 133) |
| حماية حقن الصيغ = + - @ | ✓ أي خلية تبدأ بـ `= + - @` أو Tab أو CR بتتكتب بعلامة `'` قبلها (اختبار وحدة + تكامل) |
| حد أقصى للصفوف + stream | ✓ 10000 صف، بتتعد قبل أول بايت → `422 EXPORT_TOO_LARGE {rows, maxRows}` |
| حد أقصى للفترة 366 يوم | ✓ التقارير بترفض (422) أي فترة أطول بدل ما تقصّها؛ التصدير كمان لما يكون فيه `from` |
| cache قصير للرئيسية | ✓ 60 ثانية |

## قرارات

1. **`orders.export` صلاحية جديدة، مش `orders.view`**: التصدير نسخة جماعية من بيانات العملاء. ما ضفتهاش لأي دور نظام غير المالك (`*`) — أدوار النظام بتتنسخ لكل متجر وقت إنشائه، فإضافتها لـ `workspace_manager` كانت هتطبق على المتاجر الجديدة بس، وتعديل القديمة محتاج migration (الدفعة دي من غير migration). الأدوار المخصصة تقدر تاخدها من محرّر الأدوار. الأكثر أمانًا، ومفيش حد خسر حاجة لأن التصدير ماكانش موجود.
2. **أعمدة التواصل** = الهاتف + الهاتف البديل + **البريد**: البريد اتعامل زي التليفون (بيانات تواصل) — القراءة الأكثر أمانًا. من غير `customers.reveal_sensitive`: الأعمدة الافتراضية من غيرها، وطلبها بالاسم = 403 واضح بدل حذف صامت.
3. **أكبر من الحد = رفض قبل الكتابة**، مش ملف مقطوع بسطر نص في آخره. والتصدير ثابت على لحظة بدايته (`created_at <= asOf`) عشان العدّ والصفوف يوصفوا نفس المجموعة.
4. **366 يوم**: رفض صريح (422) بدل القص الصامت اللي في `analyticsService.resolveRange` القديم (ما اتلمسش).
5. **الـ cache في ذاكرة العملية**: Redis ممنوع. كل نسخة من السيرفر ليها cache خاص — مقبول لـ 60 ثانية. نهايات الفترة بتتقرّب لأعلى دقيقة عشان طلب اتعمل من ثانية يبان، والطلبات المتكررة في نفس الدقيقة تصيب الـ cache.
6. **التعريفات**: الطلبات والمبيعات بـ `countsAsSaleSql` (الطلب المدفوع مسبقًا اللي ما اتدفعش مش طلب)، والمبيعات من غير الملغي/المرفوض؛ نسبة التأكيد بنفس تعريف صفحة التحليلات؛ نسبة التسليم = متسلّم ÷ اللي خرج مع شركة الشحن؛ التحويل = مشتريات متتبَّعة ÷ جلسات (نفس صفحة التحليلات)؛ **العميل الجديد = أول طلب له في الفترة** (مش تاريخ إنشاء سجل العميل — اتصلّح بعد مراجعة بصرية؛ الكوميت `58eba34`).
7. **إسناد UTM**: عن طريق حدث الشراء بتاع الطلب (اللي بيحمل مصدر الجلسة الأول)؛ `content/term` من أول صفحة في جلسة الشراء كانت شايلة الوسم؛ القيم lower-case و trim؛ أول 200 صف حسب المبيعات و `truncated` لو أكتر.
8. **الطلبات التجريبية (test)**: مش موجودة لسه (الدفعة 03). لما `is_test` ييجي، لازم الرئيسية وUTM والتصدير يستبعدوها — مسجّل للدفعة 03.
9. اسم الملف `orders-YYYY-MM-DD.csv` بتاريخ التصدير (UTC).
10. **أداء**: بعد EXPLAIN على بيانات كبيرة، عدّ الجلسات والزوار المميزين بقى من تمريرة واحدة بعد إزالة التكرار بدل `count(DISTINCT)` تحت `GROUPING SETS` (الكوميت `28b1613`) — نفس الأرقام، وقت أقل (التفاصيل تحت).

## محتاج قرار

- لا شيء يخص فلوس/مصادقة/حذف في الدفعة دي.
- (اختياري) هل `workspace_manager` يحتاج `orders.export` في المتاجر الموجودة؟ لو أيوه، محتاج migration صغيرة تضيفها للأدوار القائمة — ما اتعملتش.

## اللي اتشال من نسخة مصطفى وليه

- تحويل العملة في الرئيسية (`fxService`) — مزوّد عملات تجريبي (ممنوع).
- صافي الربح من `pnlService`، والإنفاق الإعلاني و ROAS/CPA في تقرير UTM (`ad_spend_daily`) — الدفعة 04.
- مؤشرات الطلبات الضايعة و lost rate و leads و cross-sell adds — بتعتمد على الدفعات 05/07 وأحداث مش بيبعتها الستورفرونت عندنا.
- جدول العروض (bundle/bump/upsell) — الدفعة 07.
- فلتر `funnelId` في الرئيسية وUTM — مش مطلوب في الدفعة؛ ممكن يتضاف بعدين بدون migration.
- العرض المباشر SSE (`realtimeStream`) — خارج نطاق الدفعة.
- فرونت مصطفى للشاشات دي كله `mockApi` + seed في localStorage — **ما اتنقلش منه سطر**؛ الشاشات اتبنت على الـ endpoints الحقيقية.

## ثغرات في كود مصطفى (ما اتنقلتش)

| المكان (zimos-additions @ 9a11f28) | المشكلة |
|---|---|
| `src/modules/orders/orderRoutes.js:37-38` | التصدير بـ `orders.view` بس، وأعمدة التليفون والبريد بتطلع لأي دور بيشوف الطلبات (مفيش فحص `customers.reveal_sensitive`) → تسريب جماعي لبيانات العملاء من موظف تأكيد أو تشغيل. |
| `src/modules/orders/orderExportController.js:31` | الـ audit بيسجّل `filters` كاملة ومنها نص البحث `q` (ممكن يكون تليفون/اسم عميل) جوه سجل المراجعة. |
| `src/modules/orders/orderExportService.js:313` | التصدير الأكبر من الحد بيضيف سطر نص حر في آخر الـ CSV («Stopped at…») — بيفسد الملف لأي أداة، ومن غير عدّ مسبق. |
| 22 استخدام مباشر لـ `req.ip` (منها `src/modules/audit/auditService.js:30`، `src/app.js:112`، `src/modules/auth/authService.js:42,96,104,201,405`، `src/modules/auth/twoFactorService.js:175`، `src/core/middleware/rateLimiters.js:45`، `src/modules/contacts/formService.js:151`، `src/modules/marketing/browserEventRelay.js:143`، `src/modules/analytics/storefrontEventsController.js:14`، `src/modules/risk/visitorGate.js:49`، `src/modules/funnels/funnelsService.js:900`، `src/modules/funnels/funnelOfferMerge.js:286`) | بيتخطى مصدر الـ IP الموثوق (`clientIp(req)` عندنا). |
| `src/modules/checkoutSessions/lostOrderService.js:643` | `recovery_token = md5(random()::text || id)` — `random()` مش CSPRNG، token قابل للتخمين. (الدفعة 05 هتستخدم `crypto.randomBytes` بس.) |

## الاختبارات

- **باك — جديد**: `tests/integration/homeOverview.test.js` (12)، `tests/integration/utmReport.test.js` (8)، `tests/integration/orderExport.test.js` (12)، `tests/unit/csvCell.test.js` (8) — كلها ✓. بتغطي: الملكية بين متجرين (أرقام المتجر التاني ما بتدخلش + 404 لغير العضو)، الصلاحيات الناقصة (403 لكل دور ناقص، و `orders.export` بدون `orders.view`)، أعمدة التواصل بالصلاحية وبدونها، حقن الصيغ، الحد الأقصى (10001 صف حقيقي في الاختبار)، الترقيم عبر أكتر من صفحة بنفس `created_at`، الـ audit، الـ cache، و 366 يوم.
- **باك — المتأثر**: `analyticsAccess` (اتضاف لها overview و utm)، `orderListSortAndTimeline`، `orderPipeline`، `storefrontEvents`، `rbac`، `workspaceRoles`، `clientIp`، `tenantIsolation`، `unit/orderSortAndTimestamps` — 100/100 ✓.
- **باك — كامل**: 129 ملف / 1817 اختبار: **1816 ✓ و 1 ✗**. الفاشل `signupVerification.test.js › caps codes from one IP in an hour, before an account is even made` بيفشل **بنفس الشكل على `main` نظيف** (worktree من `42b5b53`، نفس القاعدة): الاختبار بيزرع الأكواد بـ `requestIp: '::ffff:127.0.0.1'` والسيرفر في البيئة دي بيشوف `127.0.0.1`، فالحد ما بيتحسبش. مش من الدفعة وما اتلمسش (خارج النطاق).
- **فرونت**: `DashboardHomePage.test.tsx` (7)، `UtmReportPage.test.tsx` (6)، `OrderExportDialog.test.tsx` (6)؛ suite الداشبورد كامل 51 ملف / 597 اختبار ✓ (كان 580). اختبار `UsernameField` (مش من الدفعة) وقع مرة تحت ضغط CPU وعدّى 3/3 لوحده و في إعادة الـ suite كاملة — حساس للتوقيت.
- `tsc -b` للداشبورد و platform-admin ✓، `tsc --noEmit` للستورفرونت ✓، `npm run build:dashboard` ✓، `npm run build:storefront` ✓، `oxlint` على الملفات المتغيرة ✓.
- **مراجعة بصرية حقيقية**: باك محلي على قاعدة مؤقتة + بيانات اتعملت عن طريق الـ API نفسه (مش محفوظة في أي ريبو)، و Playwright: الرئيسية (en فاتح ديسكتوب، ar داكن 390px، ar فاتح ديسكتوب)، UTM (en فاتح، ar داكن 390px)، نافذة التصدير (ar فاتح 390px، en داكن ديسكتوب) — `dir` صح ومفيش scroll أفقي للصفحة عند 390px. وملف CSV حقيقي اتنزّل من السيرفر: BOM، عناوين عربي، توقيت القاهرة، و 422 لفترة > 366 يوم. المراجعة دي طلّعت إصلاحين (العميل الجديد، وشارة الحالة بالإنجليزي في الواجهة العربية + شريحة المقارنة في UTM).

## EXPLAIN على بيانات كبيرة

قاعدة محلية مؤقتة منفصلة (`zimos_explain`، PostgreSQL 16، 4 vCPU، `work_mem` الافتراضي 4MB، `ANALYZE` بعد التحميل) — اتملت بـ `generate_series` من سكريبت خارج الريبو، ومحفوظة نتايجها بس هنا:
10 متاجر: متجر كبير 400 ألف طلب على 400 يوم (~1000/يوم) و ~4 مليون حدث و 200 ألف عميل، و 9 متاجر 40 ألف طلب و 200 ألف حدث. الإجمالي: 760 ألف طلب، 1.52 مليون بند، 254 ألف شحنة، 6.26 مليون حدث.

الأداة بتنادي الـ services الحقيقية وبتعمل `EXPLAIN (ANALYZE, BUFFERS)` لكل SQL قبل ما يتنفذ — فالوقت الكلي ≈ ضعف الحقيقي، والاستعلامات المتوازية بتتنافس على 4 أنوية.

| الاستدعاء (المتجر الكبير) | قبل | بعد `28b1613` |
|---|---|---|
| الرئيسية 365 يوم | 21.3s | 15.0s |
| الرئيسية 30 يوم (الافتراضي) | 4.1s | 3.3s |
| UTM 365 يوم حسب المصدر | 29.1s | 24.8s |
| UTM 30 يوم حسب المحتوى (lookup صفحة الهبوط) | 2.8s | 3.0s |
| عدّ التصدير بدون تواريخ (400 ألف طلب) → 422 | 0.25s | 0.23s |
| تصدير 7 أيام كامل (7754 صف، 1.36MB، 16 صفحة) | 1.56s | 1.59s |

ملاحظات الخطط:
- طلبات الفترة: `orders_workspace_created_idx` (Bitmap Index Scan) لـ 30 يوم؛ لـ 365 يوم (36% من الجدول) المخطّط بيختار Seq Scan — متوقع.
- مرحلة الطلب (`LATEST_SHIPMENT_JOIN`): `shipments_order_id_idx` لكل طلب.
- العميل الجديد/العائد: `orders_workspace_id_customer_id_idx` لكل مشتري.
- المشتريات: `analytics_events_workspace_id_event_name_created_at_idx` (~50ms لـ 30 يوم).
- التصدير: العدّ Index Only Scan على `orders_workspace_created_idx` (1.5ms لـ 7 أيام، 154ms لـ 400 ألف)، وكل صفحة 500 طلب Index Scan بالـ keyset (~3ms)، والبنود `order_items_order_id_idx` (~30ms)، والشحنات `shipments_order_id_idx` (~2ms).
- الأتقل: الجلسات/الزوار المميزين على الأحداث. `count(DISTINCT)` تحت `GROUPING SETS` كان بيرتّب كل الأحداث مرة لكل تجميع وبيكتب على الديسك (external merge ~160MB)؛ الكوميت `28b1613` بيجمّع كل (يوم، جلسة) مرة واحدة (HashAggregate: 3.87M حدث → 1.13M زوج) وبيعدّ منها، والمشتريات من الـ index، والأيام `date` بدل `to_char` لكل صف. الأرقام نفسها ما اتغيرتش (نفس الاختبارات 39/39).

- طلب الرئيسية الواحد بيشغّل لحد 9 استعلامات بالتوازي (فترتين × 4 + المنتجات) من pool حجمه الافتراضي 10 (`DB_POOL_MAX`) — سريع للمتاجر العادية، ولو متاجر كبيرة كتير فتحت الرئيسية في نفس اللحظة الطلبات هتستنى في الطابور (الـ cache بيقلل التكرار).

الخلاصة: الفترات الافتراضية (30 يوم) مقبولة (~1–2 ثانية للاستعلام على متجر بالحجم ده، والرئيسية عليها cache 60 ثانية). سنة كاملة لمتجر بـ ~4 مليون حدث في السنة بتاخد ثواني لأن لازم يتقرا كل الأحداث. الحل اللي بيكبر: جداول تجميع يومية (جلسات/زوار/طلبات حسب اليوم والمصدر) يحدّثها worker — محتاجة migration و worker، فمش في الدفعة دي (من غير migration)؛ مقترحة مع الدفعة 08.

## البحث عن البيانات الوهمية

بحث في السطور المضافة (`git diff -U0 origin/main...` في الريبوين، من غير `port-notes/`) عن `demo|mock|fake|sample|placeholder|lorem` و (في الفرونت) `localStorage|sessionStorage`:

- كود الباك (`src/`, `docs/`): **0**.
- اختبارات الباك: **0**.
- كود الفرونت (غير الاختبارات): **0** (ولا `localStorage`/`sessionStorage`).
- اختبارات الفرونت: 22 سطر — كلها أداة الاختبار المشتركة (`api` المزيّف من `@/test/mocks` و `fake<T>()`)، مكانها ملفات الاختبار بس.
- الأرقام الثابتة في الكود المضاف: كلها حدود/إعدادات (500 صفحة، 10000 صف، 60 ثانية، 366 يوم، 200 صف UTM، أطوال حقول Joi، أكواد HTTP في تعليقات) — مفيش رقم معروض مختلق.

## جداول جديدة / migrations / متغيرات

- migrations: **لا يوجد** (التالي 133).
- جداول جديدة: **لا يوجد**.
- متغيرات بيئة جديدة: **لا يوجد**. صلاحية جديدة: `orders.export`.
