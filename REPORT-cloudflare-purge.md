# Purge-on-publish لكاش الستورفرونت على Cloudflare

الهدف: أي تعديل من التاجر بيظهر في المتجر يمسح صفحات المتجر ده من كاش Cloudflare فورًا،
بدل ما يستنى `s-maxage=60` (+ `stale-while-revalidate=300`) اللي الستورفرونت بيرجّعه
لما `STOREFRONT_EDGE_CACHE_ENABLED=true`.

## 1. الخيار المختار: purge by hostname

### اللي اتأكدت منه في توثيق Cloudflare

- **Changelog رسمي بتاريخ 2025-04-01:** "All cache purge methods now available for all plans".
  Purge by tag وhostname وprefix وURL وpurge everything بقت متاحة لكل الخطط، والخطة
  المجانية منهم
  ([developers.cloudflare.com/changelog/post/2025-04-01-purge-for-all](https://developers.cloudflare.com/changelog/post/2025-04-01-purge-for-all/)،
  ومعاه بوست [Instant Purge for all](https://blog.cloudflare.com/instant-purge-for-all/)).
- **الـ endpoint:** `POST /zones/{zone_id}/purge_cache` وفيه body `{"hosts": [...]}`
  ([API reference](https://developers.cloudflare.com/api/resources/cache/methods/purge/)،
  [Invalidate cached content](https://developers.cloudflare.com/cache/guides/invalidate-cache/)).
  الـ token محتاج صلاحية **Zone › Cache Purge › Purge**.
- **حدود الـ rate في الخطة المجانية لـ tag/host/prefix/everything:** 5 requests في الدقيقة،
  bucket حجمه 25، و100 عملية على الأكثر في الـ request الواحد. الحد ده على مستوى الـ
  **account** كله، مش لكل zone ([Purge cache](https://developers.cloudflare.com/cache/how-to/purge-cache/)).
  الأرقام دي جاية من نتايج بحث بتقتبس الصفحة. الأرقام المعروفة للخطط التانية: Pro فيها
  5/ثانية، وBusiness فيها 10/ثانية.
- **تنبيه:** الـ sandbox اللي اشتغلت فيه مقفول على `developers.cloudflare.com`، فماقدرتش
  أفتح الصفحات بنفسي. التأكيد جه من نتايج بحث بتقتبس الـ changelog والبلوج والدوكس
  الرسمية. يُفضّل حد يبص على صفحة [Purge cache](https://developers.cloudflare.com/cache/how-to/purge-cache/)
  بنفسه قبل الإنتاج، وخصوصًا جدول الـ rate limits.

### ليه hostname مش tag ولا URL

| | hostname ✅ | tag | URL |
|---|---|---|---|
| تعديل في الستورفرونت | مفيش | لازم `Cache-Tag: store-<id>` على كل رد متكاش، ولو رد واحد نسيه هيفضل قديم | مفيش |
| بيغطي query strings (`?page=2`, `?sort=`, `?collection=`) | أيوه، الـ host كله | أيوه | لأ، لازم تعدّ كل الـ URLs |
| حدود المتجر | الـ host هو المتجر بالظبط (`<slug>.zimos.co`) | التاج | قايمة URLs |
| rate limit (Free) | 5/دقيقة | 5/دقيقة (نفس الـ bucket) | أكبر بكتير، بس بيفوّت صفحات |

كل متجر عنده host لوحده، وCache Rule بتكاش `*.zimos.co` بالـ URL كامل والـ host منه،
فالـ hostname purge بيمسح **كل** صفحات المتجر ده بالظبط ومش بيلمس أي متجر تاني. ومش
محتاج أي تغيير في الستورفرونت. التاج كان هيدّي نفس النتيجة، بس محتاج تعديل في
الستورفرونت وبيزوّد مكان ممكن يتنسي فيه الهيدر، والـ rate limit بتاعه هو هو.

## 2. Environment variables (الباك إند فقط)

| المتغير | القيمة | ملاحظة |
|---|---|---|
| `CLOUDFLARE_PURGE_ENABLED` | `true` بالظبط | أي قيمة تانية أو فاضي = مقفول، ومفيش أي طلب خارجي. الافتراضي `false` |
| `CLOUDFLARE_API_TOKEN` | Token فيه **Zone › Cache Purge › Purge** على zone الـ `zimos.co` | نفس الـ token بتاع الـ custom domains. لو بتستخدمه هناك كمان، ضيف الصلاحية دي جنب **SSL and Certificates: Edit** |
| `CLOUDFLARE_ZONE_ID` | الـ zone id بتاع `zimos.co` (32 hex) | نفس المتغير بتاع الـ custom domains |
| `PLATFORM_ROOT_DOMAIN` | `zimos.co` | موجود أصلًا. الـ host بيتبني منه: `<slug>.PLATFORM_ROOT_DOMAIN` |

- الـ token والـ zone id بيتقروا من الـ env بس (`src/config/env.js` → `env.cloudflarePurge`).
- **مش بيتسجلوا في اللوج أبدًا.** لو Cloudflare رجّع رسالة خطأ فيها الـ zone id (زي
  `7003 Could not route to /zones/<id>/…`)، الـ zone id والـ token بيتشالوا منها قبل
  التسجيل. وأخطاء الشبكة بتتسجل بالـ code بتاعها بس (`ECONNRESET`).
- لو الـ flag شغال من غير token أو zone صالحين: warning واحدة من غير ما تذكر أي قيمة، ومفيش
  أي purge.
- تحت `NODE_ENV=test` بيبدأ مقفول وفاضي، والتيست بيحطهم بنفسه. `.env` ماتلمسش. اتضاف
  المتغير الجديد في `.env.example` بس.

## 3. التصميم

`src/modules/storefront/cloudflarePurge.js`

- **`purgeStore(workspaceId, { previousSlug })`:** fire-and-forget، بيرجع فورًا ومش بيرمي
  exception أبدًا، فمش بيبطّأ ولا بيفشّل طلب التاجر.
- **Debounce لكل متجر:** أي تغييرات جت ورا بعض بفرق أقل من 2 ثانية بتطلع purge واحد بعد
  ما المتجر يهدى 2 ثانية. ولو التاجر بيحفظ من غير توقف، الـ purge بيحصل برضه بعد 10 ثواني
  على الأكتر من أول تغيير. يعني 20 حفظة ورا بعض = request واحد.
- **وقت التنفيذ:** بيقرا الـ slug الحالي من الـ DB، فبعد تغيير الـ subdomain الـ host الجديد
  هو اللي بيتبعت، ومعاه القديم.
- **Rate limit:** token bucket فيه 5 requests ويتملى واحد كل 12 ثانية (5/دقيقة)، يعني تحت
  حد الخطة المجانية (5/دقيقة، bucket 25 على مستوى الـ account)، وسايب مساحة لـ process
  تاني أو لـ purge يدوي من الداشبورد.
- **تجميع:** المتاجر اللي اتأخرت بسبب الـ rate limit بتتبعت مع بعض في request واحد، **30 host**
  على الأكتر. كل host فيهم متجر اتغير فعلًا، فالـ purge لسه محدد بالمتجر.
- **Retry:** مرة واحدة على 429، وبيستنى `Retry-After` (أقصاه 60 ثانية، والافتراضي 15)،
  ومفيش أي request تاني بيطلع قبله. ومرة واحدة على 5xx أو لو مفيش رد خالص (timeout 10
  ثواني). أي 4xx تاني (403 لو الـ token مالوش صلاحية) مش بيتعاد. وبعد كده `warn` بس، والصفحات
  بتنتهي لوحدها خلال s-maxage.
- **النجاح:** بيسجل `info` فيه `[cloudflare-purge] purged {"hosts": [...]}`.

### الأمان: متجر واحد، ومفيش purge everything أبدًا

- الـ body اللي بيطلع دايمًا `{"hosts": [...]}` بس. مفيش `purge_everything` ولا
  `prefixes` ولا `tags` ولا `files` في أي مسار في الكود.
- كل host لازم يكون `<label>.<PLATFORM_ROOT_DOMAIN>`، والـ label لازم يكون DNS label صالح
  (`SLUG_PATTERN`، 63 حرف على الأكتر)، ومش واحد من:
  - `RESERVED_SLUGS` (`www, api, admin, app, store, mail, ftp, cdn, ns1, ns2, blog, help, support, status, staging, dev, test`)
  - `media`, `customers`, `fallback`
  - الـ CNAME target بتاع الـ custom domains (`CUSTOM_DOMAIN_CNAME_TARGET`)

  يعني **app/api/media/admin/www عمرهم ما بيتبعتوا**، حتى لو حصل bug وجه slug بالاسم ده،
  والتيستات بتغطي ده. ولو `PLATFORM_ROOT_DOMAIN` مش domain فيه نقطة، مفيش purge خالص.
- الـ host بيتجاب من `workspaces.slug` للمتجر نفسه. والـ `previousSlug` جاي من
  `before.slug` في audit الـ `workspace.update`.
- دومينات التجار الخاصة مش بتتكاش (بتعدي من الـ Worker)، فمش بتتعمل لها purge.

## 4. نقاط الاستدعاء (من مكان مركزي)

`storefrontCache.invalidate(workspaceId)` كان أصلًا النقطة اللي كل تغيير بيظهر في المتجر
بيعدي منها عشان يمسح الكاش الداخلي (60 ثانية في الذاكرة). دلوقتي بتنادي `purgeStore` كمان،
سواء الكاش الداخلي شغال أو لأ. فمفيش ولا controller اتنسخ فيه كود.

### أ) كل تعديل عليه audit: `recordAudit` → `storefrontCache.onAudit` → بعد الـ commit → `invalidate`

`recordAudit` بقى بيبعت الـ `action` و`before`/`after` كمان. أي audit على `entityType` من
اللي تحت بيعمل purge بعد ما الـ transaction تتعمل لها commit، ولو حصل rollback مفيش purge.

| المطلوب | الـ entity types / الأكشنز |
|---|---|
| التصميم والثيم والأقسام (نشر/حفظ) | `Website` (`website.publish/rollback/update/create/delete`)، `WebsitePage` (`page.*`: الـ header/footer/active flags بتشتغل فورًا من غير publish)، `Workspace` (`theme.activate`، `theme.reset`، `themeSettings` في `workspace.update`) |
| منتج / كولكشن / أسعار / مخزون من التاجر | `Product`، `ProductVariant` (`product.*`، `variant.*`، `product.bulk_*`، `product.duplicate`، `product.import` منتج منتج، `inventory.adjust` من الـ public API)، `Collection`، `Offer`، `Bundle` |
| إعدادات المتجر (الاسم، اللوجو، الألوان، الـ tagline) | `Workspace` (`workspace.update`، `workspace.branding.update`، `holiday_mode.update`، `gift_options.update`…) |
| الشحن المعروض | `ShippingZone`، `ShippingRate`، `ShippingProfile` **(جديد)**، `DeliveryZone` **(جديد)**، `Workspace` (`shipping.*`) |
| كوبونات / كومبو | `Discount`، `ProductCombo` **(جديد)**، `Bundle`، `Offer` |
| الريفيوز لما تتوافق | `Review` (`review.approve/reject/hide…`، `review.create_manual/update_manual`). الـ `review.submit` من الشوبر لأ، لأنه `pending`. |
| تغيير الـ subdomain | `workspace.update` اللي فيه `before.slug ≠ after.slug` بيعمل purge **للقديم والجديد** |
| حاجات تانية بتظهر في الصفحات | `Media`، `Translation`، `TrackingPixel`، `WorkspaceCustomCode`، `WorkspaceApp`، `TaxRate`، `Domain`، و**الجديد**: `SpecKey`، `ProductQuestion`، `SizeChart`، `BlogPost`، `BlogCategory`، `ShoppableImage` (looks)، `Course` (/learn)، `UrlRedirect`، `Experiment` (A/B test صفحة المنتج)، `Subscription` (المتجر بقى live، تغيير الخطة)، `WorkspaceFeatureOverride` (منح من الكونسول زي إخفاء "Powered by") |

- **مستثنى (`UNSEEN_ACTIONS`)**، لأنه مش بيغيّر حاجة الشوبر شايفها: `product.export`،
  `review.submit`، `media.upload` (ملف في المكتبة لسه ما اتستخدمش)، `tracking_pixel.test_event`.
  ده كمان معناه إن الشوبر ماعندوش أي طريقة يعمل بيها purge.
- الأنواع الجديدة و`UNSEEN_ACTIONS` بيطبقوا على الكاش الداخلي كمان، لأنهم نفس القايمة،
  وده تصحيح في صالحه.

### ب) كتابات من غير audit، وكلها بتنادي `invalidate` مباشرة

| المكان | إمتى |
|---|---|
| `inventory/inventoryService.js` `restock` / `returnRestock` / `adjustStock` | كان موجود قبل كده. أي مخزون التاجر بيضيفه أو بيصححه |
| `inventoryService.reserve` / `release` / `commit` **(جديد)** | **بس** لما الفاريانت **يقلب** من متوفر لنفاد أو العكس، بنفس قاعدة الستورفرونت (`allowOverselling \|\| stockOnHand − reservedStock > 0`). باقي الأوردرات مش بتعمل purge، وإلا المتجر اللي عليه زحمة عمره ما هيتكاش |
| `sizeCharts` PUT / DELETE **(جديد)** | تعديل أو حذف جدول مقاسات |
| `productQuestions` DELETE **(جديد)** | حذف سؤال |
| `urlRedirects` PUT / DELETE **(جديد)** | تعديل أو حذف redirect |
| `productSpecs`، `holidayMode`، `giftOptions` | كانوا بينادوا `invalidate` أصلًا |
| `domains/domainSettings` و`domainsService` و`domainJobs` | تغيير الدومين الأساسي أو الشهادة (الـ subdomain يبدأ يعمل redirect للدومين أو يبطّل). **اتعدّل:** `pollPendingCertificates` بقى بيعمل invalidate بس لو حالة الدومين اتغيرت فعلًا، بدل كل 5 دقايق لكل دومين لسه pending |

## 5. حدود معروفة

1. **الحالة في ذاكرة كل process:** الـ debounce والـ bucket لكل process لوحده. لو فيه N
   process (API replicas + worker)، في أسوأ الأحوال ممكن يطلع N × 5 requests في الدقيقة.
   ولو حصل 429، الـ retry والـ warning بيغطوه. والـ restart بيضيّع الـ purges اللي كانت
   مستنية، والصفحات بتنتهي لوحدها خلال s-maxage.
2. **الحد على مستوى الـ account:** الـ 5/دقيقة في Free مشتركة بين كل الـ zones اللي على
   نفس الخطة، ومع أي purge يدوي.
3. **التغييرات المرتبطة بالوقت مش كتابة، فمش بتعمل purge:** خصم بيبدأ أو بيخلص في ميعاد،
   holiday mode بيخلص لوحده، countdown، اشتراك وصل لآخر يوم سماح. دي بتتغطى بالـ TTL (60
   ثانية + SWR).
4. **التغييرات على مستوى المنصة** (سحب ثيم من الكتالوج، `Theme` بـ `workspaceId = null`، أو
   إعدادات المنصة اللي بتظهر في المتاجر) محتاجة purge لكل المتاجر، وده ممنوع عن قصد.
5. **أوردرات مش بتقلب المخزون**، وكوبون وصل لحد الاستخدام بسبب أوردر: مفيش purge، والـ TTL
   بيغطيهم.
6. **الدومينات الخاصة** مش متغطية لأنها مش متكاشة أصلًا.
7. **الترجمات** بتأثر بس على الزوار اللي معاهم cookie لغة، ودول أصلًا بيعدّوا الكاش
   (Cache Rule بتستثني `zimos_store_`). فالـ purge هنا مالوش لازمة بس مش بيضر.
8. **التوقيت:** الـ purge بيحصل بعد 2 ثانية على الأقل من آخر حفظة، و10 ثواني على الأكتر لو
   الحفظ مستمر، وبعدها propagation بتاع Cloudflare. أول زيارة لكل صفحة بعد الـ purge بتبقى
   MISS (render من الـ origin).
9. **محرر الموقع:** `page.update` (حفظ الدرافت) بيعمل purge كمان، لأن flags الصفحة (هيدر،
   فوتر، active) بتشتغل فورًا. التكلفة الوحيدة من ميزانية الـ API، والـ debounce والتجميع
   بيقللوها.
10. **audit من غير transaction** بيعمل purge بعد 2 ثانية، يعني عمليًا بعد الـ commit. لو
    transaction طولها أكتر من 2 ثانية ومش متباصية لـ `recordAudit`، ممكن الكاش يتملى بالقديم
    لحد ما الـ TTL يخلص.
11. **الـ token مشترك** مع الـ custom domains، فلازم يبقى فيه الصلاحيتين. لو عايز least
    privilege، المفروض متغير منفصل لـ token الـ purge، وده مش متضاف التزامًا بالمطلوب.
12. **سطور اللوج** بتاعة الـ purge بتشيل الـ request context (requestId/workspaceId/userId)
    بتاع الطلب اللي جدولها، لأن الـ timers بتورث الـ async context. مفيش فيها أي سر.
13. **الحد 30 host في الـ request** اخترته عن قصد أقل من الـ 100 بتاعة الدوكس الحالية،
    كهامش أمان.

## 6. الاختبارات

على DB خاص (`zimos_purge_test`)، مش `zimos_dev`، ومن غير ما ألمس `.env`:

```bash
createdb zimos_purge_test
NODE_ENV=test DB_NAME_TEST=zimos_purge_test DB_PASSWORD=… npx sequelize-cli db:migrate
DB_NAME_TEST=zimos_purge_test DB_PASSWORD=… npx cross-env NODE_ENV=test jest --runInBand tests/unit/cloudflarePurge.test.js tests/integration/cloudflarePurge.test.js
```

- **`tests/unit/cloudflarePurge.test.js`** (fetch عليه mock، والساعة fake):
  - flag off = صفر طلبات خارجية وصفر lookup
  - flag on من غير token = صفر طلبات، وwarning واحدة
  - 20 حفظة = request واحد بعد ما المتجر يهدى 2 ثانية
  - سقف الـ 10 ثواني
  - الـ URL والـ method والـ Bearer header، والـ body = `{hosts:[…]}` بس
  - القديم والجديد بعد تغيير العنوان
  - app/api/admin/media/www/customers/… عمرهم ما بيتبعتوا
  - الـ bucket (5 فورًا، وبعدها واحد كل 12 ثانية) وتجميع 30 host
  - 429 + Retry-After، وretry واحد بس
  - 5xx بيتعاد، و4xx لأ
  - مفيش رد = retry وبعده warning، و`purgeStore` عمره ما بيرمي exception
  - الـ token والـ zone id مش موجودين في أي سطر لوج أو أي حاجة اتكتبت على stdout/stderr، حتى
    لو Cloudflare أو الشبكة رجّعوهم
- **`tests/integration/cloudflarePurge.test.js`**:
  - تعديل منتج / كولكشن / إعدادات المتجر = purge بعد الـ commit
  - تغيير الـ slug = القديم والجديد
  - الأوردرات، العملاء، الـ export، ريفيو pending، رفع ميديا، ثيم المنصة، rollback = مفيش purge
  - end-to-end مع Cloudflare mock: 3 حفظات = request واحد للـ host بتاع المتجر
  - Cloudflare واقع = التاجر بياخد 200 فورًا، وبعدها warn من غير أسرار
  - flag off = صفر طلبات
  - المخزون: أوردر بيبيع آخر قطعة أو بيرجّعها = purge، وأي أوردر غيره لأ
  - size chart / سؤال / redirect = purge
  - جوب الدومينات بيعمل purge للمتجر اللي دومينه اتغيرت حالته بس

## 7. خطوات الاختبار اليدوي (staging أو production)

1. **Cloudflare → My Profile → API Tokens:** على الـ token الحالي (أو واحد جديد) ضيف
   **Zone › Cache Purge › Purge** لـ zone الـ `zimos.co`.
2. **Railway (الباك إند):**
   - `CLOUDFLARE_PURGE_ENABLED=true`
   - `CLOUDFLARE_API_TOKEN=…`
   - `CLOUDFLARE_ZONE_ID=…`
   - `PLATFORM_ROOT_DOMAIN=zimos.co`

   وفي الستورفرونت: `STOREFRONT_EDGE_CACHE_ENABLED=true`، والـ Cache Rule حسب
   `zimos-frontend/docs/edge-cache/README.md`. وبعدها redeploy.
3. **سخّن الكاش:**
   ```bash
   for i in 1 2 3; do curl -s -o /dev/null -w '%{http_code} cf=%header{cf-cache-status} age=%header{age}\n' https://<slug>.zimos.co/products/<product>; done
   ```
   المفروض تشوف `MISS` وبعدها `HIT` والـ age بيزيد.
4. **غيّر اسم المنتج أو سعره من الداشبورد.** المفروض الحفظ يرجع فورًا زي ما هو. بعد حوالي
   2–3 ثواني، لوج الباك إند هيطلع فيه
   `[cloudflare-purge] purged {"hosts":["<slug>.zimos.co"]}`. نفس الـ curl هيرجع `MISS`
   والاسم أو السعر الجديد، وبعدها `HIT`.
5. **الـ debounce:** احفظ 10 مرات ورا بعض بسرعة. المفروض يطلع سطر `purged` واحد بس.
6. **غيّر الـ subdomain من الإعدادات.** السطر هيبقى فيه الـ host القديم والجديد.
7. **النفاد:** اعمل أوردر على آخر قطعة. صفحة المنتج هتقول "نفدت الكمية" خلال ثواني. ولو
   ألغيت الأوردر، المنتج هيرجع متوفر.
8. **الفشل:** شيل صلاحية Cache Purge من الـ token (أو حط zone غلط). الحفظ من الداشبورد
   هيفضل شغال عادي، واللوج هيطلع فيه `purge failed … status 403` من غير الـ token أو الـ
   zone id. رجّع الصلاحية بعدها.
9. **Flag off:** خلي `CLOUDFLARE_PURGE_ENABLED=false`. مفيش أي سطر `cloudflare-purge`،
   والصفحات بتتحدث بعد s-maxage زي الأول.
10. **مفيش تأثير على باقي الـ hosts:**
    - في Cloudflare → Audit Logs (أو Analytics)، الـ purges كلها `hosts` بأسماء متاجر بس.
    - اعمل `curl -sI https://app.zimos.co/` و`https://api.zimos.co/health` والـ media، ومش
      المفروض يتأثروا خالص.
    - دوّر في اللوج: `grep cloudflare-purge | grep -E '"(app|api|media|admin|www)\.'`
      المفروض ميرجعش حاجة.
