# Edge cache + purge-on-publish للدومينات الخاصة (custom domains)

الهدف: صفحات المتجر العامة على الدومين الخاص للتاجر (`www.merchant-shop.com`) تتكاش على
Cloudflare للزوار المجهولين، وتتمسح فورًا لما التاجر يغيّر حاجة، بنفس أمان `*.zimos.co`.
ومن غير ما متجرين يتخلطوا، ومن غير ما صفحة فيها بيانات عميل تتكاش.

النسخة دي موجودة في الريبوهين (`zimos` و`zimos-frontend`) بنفس المحتوى.

## 0. الخلاصة

- **كود الـ Worker موجود:** `zimos-frontend/worker/custom-domains-worker.js`. والريبو مش بينشره،
  النشر يدوي من داشبورد Cloudflare.
- **اقتراح (أ)، يعني Cache Rule للدومينات الخاصة، مش ممكن بأمان على الخطة الحالية.** الـ Worker
  بيشتغل **قبل** كاش Cloudflare، والحاجة الوحيدة اللي ممكن تتكاش بعده هي الـ `fetch()` بتاعه
  لـ Railway، ومفتاحها هو URL بتاع Railway، وده **مشترك بين كل الدومينات الخاصة**. يعني أي Cache
  Rule هنا ممكن تخلّي متجر يظهر على دومين متجر تاني. التفاصيل في قسم 3.
- **التصميم اللي اتطبق:** (ب) + (ج) مع الكاش جوه الـ Worker نفسه:
  - **الـ Worker** بيحفظ الصفحة في كاش الـ zone (Cache API) تحت **URL الزائر نفسه** (الـ host
    والـ path والـ query)، وعمره ما بيحفظ تحت الـ host بتاع Railway. بيحفظ بس الرد اللي
    الستورفرونت عمله mark بـ `public, max-age=0, s-maxage=…`، **زي ما هو**. يعني الـ Worker لا
    بيضيف ولا بيغيّر ولا بيشيل `Cache-Control`.
  - **الستورفرونت** بيعمل mark للصفحة بس لما يتأكد إن الطلب جاي من الـ Worker (السر)، وإن
    الـ Worker بيقول إنه هيكاشها تحت URL الزائر، وإن الـ host هو **الدومين الأساسي للمتجر
    بالظبط**، وإن الـ rewrite رايح لنفس المتجر ده. وبعدها نفس قواعد الـ subdomain ونفس الـ guard.
  - **الباك** بيمسح كمان دومينات المتجر نفسه، والدومين اللي لسه اتشال، في نفس الطلب ونفس
    الـ debounce ونفس الحد (30 host).
- **ثلاث فلاجات، كلها مقفولة افتراضيًا.** أي واحد فيهم لوحده مش بيغيّر حاجة الشوبر بيشوفها،
  ولو مقفولين السلوك هو هو بالظبط (التستات بتثبت ده). الاستثناء الوحيد هو إصلاح `robots.txt`
  اللي تحت.
- **مفيش Cache Rule جديدة.** المطلوب يدويًا في Cloudflare: تنشر الـ Worker الجديد، وتتأكد من الـ
  compatibility date، وتضيف متغير واحد. التفاصيل في قسم 6.
- **إصلاح تسريب `robots.txt` (من غير فلاج):** الملفات اللي كل متجر بيولّدها لنفسه
  (`/robots.txt` و`/sitemap.xml` و`/manifest.webmanifest`) كانت ممكن تتكاش تحت URL بتاع Railway،
  ومشتركة بين كل الدومينات الخاصة. دلوقتي الـ Worker بيطلبها دايمًا بـ `cache: "no-store"`. محتاج
  مسح لمرة واحدة بعد النشر. التفاصيل في قسم 4.4.

## 1. كود الـ Worker

| الملف | الريبو |
|---|---|
| `worker/custom-domains-worker.js` | `zimos-frontend` |
| `worker/custom-domains-worker.test.mjs` (جديد) | `zimos-frontend` (`npm run test:worker`) |
| خطوات الإعداد | `docs/custom-domains/README.md`، و`docs/edge-cache/README.md` قسم 4 |

## 2. المسار الكامل، وفين الكاش بيحصل

### 2.1 النهارده (قبل التغيير)

```
زائر ─ https://www.merchant-shop.com/products/x
  │  DNS: www → CNAME customers.zimos.co (proxied)
  ▼
Cloudflare edge، zone zimos.co (custom hostname + شهادة Cloudflare for SaaS)
  │  قواعد الـ zone بتتطبق على طلب الزائر (WAF، …)
  │  Workers Route */* بيطابق (zimos.co/* = None للـ subdomains)
  │  ⇒ الـ Worker بيشتغل «قبل الكاش»: مفيش أي lookup في الكاش على URL الزائر
  ▼
Worker zimos-custom-domains
  │  fetch("https://<ORIGIN_HOST>/products/x")  + X-Zimos-Host / X-Zimos-Edge / …
  │  ⇒ الـ subrequest ده بيعدي على كاش Cloudflare، ومفتاحه URL بتاع Railway
  ▼
Railway edge (ORIGIN_HOST): بيكتب X-Forwarded-Host = ORIGIN_HOST
  ▼
Storefront proxy.ts: X-Zimos-Edge صح؟ → X-Zimos-Host → GET /store/resolve-host
  → rewrite /store/<slug>/products/x → Cache-Control
  ▼
الرد بيرجع زي ما هو: Railway → Worker → Cloudflare → الزائر
```

والـ subdomain للمقارنة: `<slug>.zimos.co` مش بيعدي على الـ Worker (الـ route بتاعه None).
بيقابل الـ Cache Rule، والكاش مفتاحه الـ URL كامل **بالـ host بتاعه**، وده اللي بيخلي المتاجر
منفصلة.

### 2.2 الأسئلة بالظبط

**هل طلبات الدومين الخاص بتعدي على Cache Rules بتاعة الـ zone؟**

- **طلب الزائر نفسه:** الـ custom hostname تبع zone الـ `zimos.co`، وقواعد الـ zone بتتطبق
  عليه. بس الـ Worker بيشتغل قبل الكاش، فمفيش أي lookup على URL الزائر. توثيق Cloudflare:
  *"Cloudflare Workers run before the cache but can also be utilized to modify assets once
  they are returned from the cache."* والـ Cache Rule الحالية شرطها
  `ends_with(http.host, ".zimos.co")`، فهي أصلًا مش بتطابق الدومين الخاص.
- **الـ subrequest بتاع الـ Worker لـ Railway:** التوثيق بيقول:
  *"fetch checks to see if the URL matches a different zone. If it does, it reads through
  that zone's cache (or Worker). Otherwise, it reads through its own zone's cache, even if
  the URL is for a non-Cloudflare site."*
  يعني لو `*.up.railway.app` مش على Cloudflare، الطلب بيتقرا من كاش zone الـ `zimos.co`
  بتاعتنا. ولو هو على zone تانية على Cloudflare (بتاعة Railway)، بيتقرا من كاش الـ zone دي
  بقواعدها هي.
  - **ماقدرتش أأكد:** هل Cache Rules بتاعتنا بتتقيّم على subrequest رايح لـ host برا الـ zone.
    صفحات `developers.cloudflare.com` و`blog.cloudflare.com` مقفولة في الـ sandbox، والبحث ما
    جابش نص صريح عن ده. اللي لقيته إن Page Rules (القديمة) بتتقيّم في مرحلتين: طلب الزائر
    للـ Worker، والـ subrequest بتاع الـ Worker.
  - **ومش هتفرق:** حتى لو بتتقيّم، `http.host` وقتها هيبقى `ORIGIN_HOST`، والمفتاح URL بتاع
    Railway.

**الكاش بيتحسب على أي host؟ الدومين الخاص ولا الـ origin؟**

على **الـ origin**. التوثيق صريح:
*"The asset will be cached under the hostname specified within the Worker's subrequest — not
the Worker's own hostname."*
يعني `www.store-a.com/products/x` و`www.store-b.com/products/x` الاتنين هيبقوا
`https://<ORIGIN_HOST>/products/x`، **نفس المفتاح بالظبط**.

**ليه مفيش خلط النهارده؟**

ثلاث حاجات مع بعض:
1. الستورفرونت عمره ما بيعمل mark لطلب جاي من الـ Worker، فبيرجّع `private, no-store`.
2. Cloudflare مش بيكاش HTML افتراضيًا ("does not cache HTML or JSON by default").
3. الـ Cache Rule بتطابق `.zimos.co` بس.

والـ assets اللي ليها امتداد (`/_next/static/*.js`، الصور) ممكن تتكاش تحت URL بتاع Railway،
وده مفيهوش ضرر لأنها نفس ملفات الـ build لكل المتاجر. **الاستثناء كان `robots.txt`**: Cloudflare
بيكاشه افتراضيًا، وده كان تسريب موجود قبل التغيير ده. اتصلح في قسم 4.4.

## 3. ليه اقتراح (أ) (Cache Rule) مرفوض

1. الـ Worker بيشتغل قبل الكاش، فـ Cache Rule على `http.host` بتاع الدومين الخاص مالهاش طلب
   تشتغل عليه.
2. الكاش الوحيد الممكن هو بتاع الـ subrequest، ومفتاحه URL بتاع Railway. يعني Cache Rule على
   `ORIGIN_HOST` (أو أي توسيع للـ rule الحالية لكل الـ hosts) **هتخلط المتاجر**. ولو حد ضاف
   كمان "Ignore cache-control"، ممكن صفحة `private` لزائر عنده كوكيز تتكاش.
3. إن المفتاح يشمل host الزائر في المسار ده محتاج **custom cache key**: يا إما `cf.cacheKey` في
   الـ fetch، يا إما Cache Rule بـ custom key فيه header زي `X-Zimos-Host`. والاتنين **Enterprise
   فقط** ("Enterprise only feature" في مثال *Cache using fetch*). تقرير الـ purge السابق شغال على
   حدود الخطة المجانية، فافترضت إن الحساب مش Enterprise. لو هو Enterprise، ده بديل ممكن، بس
   برضه محتاج تعديل في الـ Worker.
4. **Workers Cache** (الكاش الجديد اللي قدام الـ Worker): التوثيق بيقول إن Cache Rules مالهاش
   أي تأثير عليه، وإن *"no zone-level purge (via the dashboard, API, or Terraform) affects
   Workers Caching content"*. يعني الـ purge بالـ hostname من الباك مش هيوصله، ومفتاحه ماقدرتش
   أتأكد منه. **مرفوض.**

## 4. التصميم المختار

### 4.1 الـ Worker (`EDGE_CACHE_ENABLED`، متغير نصي، مقفول إلا لو `true` بالظبط)

```
طلب الزائر
  ├─ /robots.txt أو /sitemap.xml أو /manifest.webmanifest   → للستورفرونت بـ cache: "no-store" دايمًا (قسم 4.4)
  ├─ مش GET/HEAD، أو /_next/ أو /api/ أو ملف (فيه امتداد)  → زي النهارده بالظبط (من غير أي header)
  ├─ فيه كوكي zimos_* غير zimos_touch، أو RSC / Next-Router-* / Next-Url / Range / Authorization،
  │   أو _rsc / storePreview / paymentsPreview / zimos-view في اللينك
  │                                                          → للستورفرونت زي النهارده، X-Zimos-Cache: BYPASS
  └─ صالح:
       caches.default.match( https://<host الزائر>/<path>?<query> )
         ├─ موجود → يرجّع النسخة المحفوظة من غير Railway، X-Zimos-Cache: HIT
         └─ مش موجود:
              HEAD → للستورفرونت من غير إشارة، ومن غير حفظ (MISS)
              GET  → للستورفرونت ومعاه X-Zimos-Edge-Cache: 1 و cache: "no-store"
                     الرد بيتحفظ بس لو:
                        200 + text/html + من غير Set-Cookie
                        + Cache-Control = ^public, max-age=0, s-maxage=N(, stale-while-revalidate=M)?$
                     ويتحفظ زي ما هو (ctx.waitUntil(cache.put(...)))، X-Zimos-Cache: MISS
```

- **عزل المتاجر:** المفتاح هو `request.url` بتاع الزائر، والـ host فيه. والـ `X-Zimos-Host` اللي
  بيتبعت للستورفرونت جاي من نفس الـ URL ده (`incoming.host`). يعني المتجر اللي اتعمله render
  والمفتاح اللي اتحفظ تحته بييجوا من نفس الـ host دايمًا، حتى لو حد بعت Host أو SNI غريب.
- **`cache: "no-store"` على الـ subrequest** اللي هيتحفظ: نسخة من الصفحة عمرها ما تتحفظ تحت
  URL بتاع Railway، حتى لو حد ضاف بعدين قاعدة كاش غلط في الـ zone.
- **runtime مش بيقبل `cache: "no-store"`** (compatibility date قبل 2024-11-11، الـ flag اسمه
  `cache_option_enabled`): الـ Worker بيكتشف ده لوحده وبيرجع للسلوك القديم بالظبط. **مفيش إشارة
  بتتبعت**، فالستورفرونت مش بيعمل mark لأي حاجة. يعني بيفشل بأمان (fail closed).
- **`X-Zimos-Edge-Cache`** اللي بييجي من الزائر بيتشال دايمًا، سواء الفلاج شغال أو لأ.
- **Cache-Control:** الـ Worker مش بيلمسه خالص. اللي بيتحفظ هو رد الستورفرونت زي ما هو، والـ
  `max-age=0` بيمنع المتصفح إنه يحتفظ بالصفحة.

### 4.2 الستورفرونت (`STOREFRONT_EDGE_CACHE_CUSTOM_DOMAINS`)

`apps/storefront/src/lib/edgeCache.ts` (`merchantPage` و`edgeCacheControl`)، و`src/proxy.ts`:

صفحة الدومين الخاص بتاخد mark بس لو **كل** الشروط دي متحققة:

| الشرط | ليه |
|---|---|
| `STOREFRONT_EDGE_CACHE_ENABLED=true` **و** `STOREFRONT_EDGE_CACHE_CUSTOM_DOMAINS=true` | فلاج منفصل |
| `X-Zimos-Edge` = `CUSTOM_DOMAIN_EDGE_SECRET` (`visitor.forwarded`) | الطلب جاي من الـ Worker فعلًا |
| `X-Zimos-Edge-Cache: 1` | الـ Worker هيحفظ تحت URL الزائر، وبـ `no-store` على الـ subrequest |
| host الزائر **=** `primaryHost` اللي `resolve-host` رجّعه، بالظبط (من غير port ولا نقطة في الآخر) | المتجر معروف من الـ host: الدومين الأساسي، verified/active، وشهادته issued، ومش suspended. وده نفس الدومين اللي الباك بيمسحه |
| slug الـ rewrite (`/store/<slug>/…`) = الـ slug اللي اتعمله resolve | مستحيل نعمل mark لصفحة متجر تاني |
| GET/HEAD، route عام، ومفيش كوكي شخصي ولا preview ولا Set-Cookie ولا redirect ولا header من بتوع الـ proxy | نفس قواعد الـ subdomain |
| الـ guard وقت خروج الرد (`edgeCacheGuard`): 200 + text/html + مفيش Set-Cookie + مش RSC | نفس الـ guard، بنفس الـ mark |

وده اللي **عمره ما بياخد mark** على الدومين الخاص:
- `/cart` و`/checkout` و`/pay/*` و`/account*` و`/orders/*` و`/track` و`/offer/*` و`/f/*`،
  والـ home funnel على `/`
- الـ previews
- مسار داخلي لمتجر تاني (`/store/<slug-تاني>/…`)
- دومين غير أساسي (بيعمل 307 للأساسي)
- دومين `redirectToPrimary=false` (الـ `primaryHost` بتاعه null)
- أي طلب من غير السر أو من غير إشارة الـ Worker

وهيدر الـ Worker `x-zimos-edge-cache` عمره ما بيوصل للصفحات. ولو طلب على الـ subdomain جه بيه،
مش بياخد mark.

### 4.3 الباك (`CLOUDFLARE_PURGE_CUSTOM_DOMAINS`)

`src/modules/storefront/cloudflarePurge.js`:

- **`customHost(hostname)`** (جديدة): بترجع دومين التاجر بالشكل اللي متخزن بيه، أو null. بتعدي
  أولًا على `domainRules.checkHostname`، يعني نفس قواعد إضافة الدومين: ممنوع IP أو apex أو
  اسم مش سليم أو `zimos.co` أو `railway.app` أو `up.railway.app` أو TLD داخلي. وبعدها بترفض:
  - أي حاجة مش بالشكل المتخزن بالظبط (فيها scheme أو path أو port)
  - `PLATFORM_ROOT_DOMAIN` وأي host تحته
  - الـ CNAME target، حتى لو برا الـ zone

  و`storeHost(slug)` زي ما هي، فمنع الـ platform hosts (`app`، `api`، `admin`، `media`، `www`،
  …) مكانه.
- **وقت الـ flush:** بيقرا كل دومينات المتجر اللي `status ∈ {verified, active}`، أساسية أو لأ،
  suspended أو لأ. وبيضيف عليهم `previousHosts`، يعني الدومينات اللي اتشالت. وبيبعتهم مع الـ
  subdomain في **نفس** الطلب `{"hosts":[...]}`، بنفس الـ debounce (2 ثانية، وأقصاه 10)،
  ونفس الـ bucket، ونفس الحد (30 host للطلب).
  - **ليه كل الدومينات اللي بتتخدم، مش الأساسي بس؟** عشان لو الأساسي اتغير من A لـ B، الاتنين
    بيتمسحوا، القديم والجديد، من غير ما نحتاج نعرف "الأساسي القديم" في كل مكان بيغيّره. وبما
    إن الكاش بيحصل بس على الأساسي، الباقيين مسحهم مش بيضر، وبيتبعتوا في نفس الطلب.
- **الإزالة (القديم):**
  - `domainsService.deleteDomain` بيبعت `previousHosts: [hostname]`.
  - `storefrontCache.onAudit` بيعمل نفس الحاجة من `before.hostname` في audit بتاع `Domain`.
  - الاتنين **بس لو الدومين كان verified/active**. claim لسه pending، ممكن يكون على host
    بتاع متجر تاني، **عمره ما بيتمسح**.
- **التغييرات التانية:** تغيير الأساسي، الشهادة، الـ suspension، و`redirectToPrimary` كلها
  بتنادي `invalidate` أصلًا (`canonicalChanged` و`forgetStore`)، والصف بيفضل موجود، فبيتقرا
  وقت الـ flush.
- **الفلاج مقفول:** مفيش أي قراءة لجدول `domains`، و`previousHosts` بيتجاهل، والـ body هو
  `{"hosts":["<slug>.zimos.co"]}` بالظبط زي الأول.
- **مفيش طلبات زيادة:** الدومينات بتتبعت في نفس request بتاع الـ subdomain، فالـ rate limit (5
  في الدقيقة على Free) هو هو.

### 4.4 إصلاح `robots.txt` وملفات المتجر (مش مربوط بأي فلاج)

**المشكلة (كانت موجودة قبل التغيير ده):**
- على الدومين الخاص، الـ Worker بيطلب `https://<ORIGIN_HOST>/robots.txt`. **نفس الـ URL** لكل
  الدومينات.
- الستورفرونت بيعمل rewrite لـ `/store/<slug>/robots.txt`، اللي فيه `revalidate = 3600`، فـ Next
  بيبعت `s-maxage`.
- توثيق Cloudflare بيقول إنه *"by default … caches a website's robots.txt"*.

يعني `robots.txt` بتاع متجر (وفيه سطر `Sitemap:` بدومينه هو) ممكن كان يظهر على دومين متجر تاني
لمدة تصل لساعة.

**الإصلاح** في `worker/custom-domains-worker.js`، **دايمًا**، سواء `EDGE_CACHE_ENABLED` شغال أو لأ:
- الملفات اللي الستورفرونت بيرد عليها لكل متجر في جذر الدومين (`STORE_FILES` في
  `apps/storefront/src/proxy.ts`: `/robots.txt` و`/sitemap.xml` و`/manifest.webmanifest`) بتتطلب من
  Railway بـ `cache: "no-store"`. فـ Cloudflare مش بيقرا ولا بيحفظ أي نسخة تحت URL بتاع Railway.
  - `sitemap.xml` و`manifest.webmanifest` مش مؤكد إنهم في قايمة Cloudflare الافتراضية، بس
    اتضافوا عشان بيتولدوا لكل متجر، ومفيش تمن.
- الـ path بيتقارن بعد الـ decode والـ lowercase، فـ `/ROBOTS.TXT` و`/robots%2Etxt` بيتعاملوا نفس
  المعاملة.
- **runtime مش بيقبل `cache: "no-store"`:** الـ Worker بيبعت `cf: { cacheTtl: -1 }` بدلها. القيمة
  السالبة معناها "ماتكاشش". الكلام ده جاي من أمثلة Cloudflare (gists) ومن الـ community، بس
  ماقدرتش أقرا صفحة الـ reference نفسها.
- **باقي الطلب زي ما هو:** نفس الـ headers ونفس الرد للزائر. ومفيش أي تغيير لأي ملف تاني:
  الـ assets بتاعة الـ build تفضل Cloudflare يكاشها.

**عن "Cache-Control: no-store":** الطريقة الموثقة إن Worker يقول لـ Cloudflare "ماتكاشش الطلب ده"
هي `cache: "no-store"` في الـ `fetch`. وده اللي اتعمل. هيدر `Cache-Control` على الرد للزائر مش
هيصلح حاجة: Cloudflare بيقرر يحفظ ولا لأ لحظة ما رد Railway بيوصل، وده قبل ما الـ Worker يشوفه. وكمان
النسخة للزائر مفتاحها دومينه هو، فمفيش فيها تسريب. عشان كده الرد للزائر ما اتغيرش.

**مطلوب لمرة واحدة بعد النشر:** امسح النسخ اللي ممكن تكون اتحفظت قبل كده تحت URL بتاع Railway
(قسم 6، خطوة 1).

## 5. الفلاجات

| المكان | المتغير | الافتراضي | لما يبقى `true` |
|---|---|---|---|
| Worker `zimos-custom-domains` (Settings → Variables، نص) | `EDGE_CACHE_ENABLED` | مش موجود = مقفول | بيقرا الكاش ويحفظ فيه، ويبعت الإشارة |
| الستورفرونت (Railway) | `STOREFRONT_EDGE_CACHE_CUSTOM_DOMAINS` | `false` | بيعمل mark لصفحات الدومين الخاص (محتاج كمان `STOREFRONT_EDGE_CACHE_ENABLED=true` و`CUSTOM_DOMAINS_ENABLED=true` و`CUSTOM_DOMAIN_EDGE_SECRET`) |
| الباك (Railway) | `CLOUDFLARE_PURGE_CUSTOM_DOMAINS` | `false` | بيمسح دومينات المتجر مع الـ subdomain (محتاج `CLOUDFLARE_PURGE_ENABLED=true`) |

القيمة لازم تبقى `true` بالظبط في التلاتة. `1` أو `TRUE` أو `yes` = مقفول.

إصلاح `robots.txt` (قسم 4.4) **مالوش فلاج**، وبيشتغل أول ما الـ Worker الجديد يتنشر.

**أي فلاج لوحده مش بيغيّر حاجة:**
- الـ Worker لوحده بيبعت الإشارة، بس الستورفرونت مش بيعمل mark، فمفيش حاجة بتتحفظ. وكل الصفحات
  بتبقى MISS أو BYPASS، بنفس الـ `Cache-Control` الخاص بتاع النهارده.
- الستورفرونت لوحده: مفيش إشارة، فمفيش mark.
- الباك لوحده: بيمسح hosts مفيهاش حاجة متكاشة.

## 6. خطوات التفعيل بالترتيب (staging الأول)

1. **Merge ونشر الكود من غير ما تشغّل أي فلاج:**
   - الباك والستورفرونت: redeploy عادي، والسلوك هو هو.
   - **الـ Worker:** Cloudflare → Workers & Pages → `zimos-custom-domains` → Edit code → الصق
     `worker/custom-domains-worker.js` الجديد كله → **Deploy**. ماتضيفش `EDGE_CACHE_ENABLED`
     لسه.
   - **اتأكد إن مفيش حاجة اتغيرت في الصفحات:**
     ```bash
     curl -s -o /dev/null -D - https://www.merchant-shop.com/products/<p> | grep -iE '^HTTP|cache-control|x-zimos-cache'
     ```
     المفروض يطلع 200 و`private, no-cache, no-store…`، **ومفيش** `x-zimos-cache`.
   - **إصلاح `robots.txt` اشتغل خلاص (قسم 4.4).** امسح مرة واحدة أي نسخة اتحفظت قبل كده تحت
     URL بتاع Railway. ده بيستخدم نفس الـ token ونفس الـ zone بتوع الـ purge، وحط
     `storefront-production.up.railway.app` مكان `<ORIGIN_HOST>`:
     ```bash
     curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/purge_cache" \
       -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
       --data '{"files":["https://<ORIGIN_HOST>/robots.txt","https://<ORIGIN_HOST>/sitemap.xml","https://<ORIGIN_HOST>/manifest.webmanifest"]}'
     ```
     مع `cache: "no-store"`، الـ Worker أصلًا مش بيقرا النسخ القديمة، والمسح هنا احتياط زيادة
     (وضروري لو الـ runtime قديم وماشي بـ `cacheTtl: -1`). وفيه طريقة أوسع: `{"hosts":["<ORIGIN_HOST>"]}`،
     بس دي بتمسح كمان كل الـ assets المتكاشة تحت الـ host ده، وده مقبول لمرة واحدة.
     - **وقبل النشر**، لو حابب تتأكد إن التسريب كان موجود، شغّل التشييك اللي في قسم 7
       (`robots.txt`) على الـ Worker القديم.
2. **الـ compatibility date بتاع الـ Worker:** Settings → Runtime → Compatibility date. لازم
   يكون **2024-11-11 أو بعده**، أو يكون فيه compatibility flag اسمه `cache_option_enabled`.
   اسم الـ flag والتاريخ من الـ changelog بتاع `Request.cache`، فيُفضّل تتأكد منهم في الداشبورد.
   لو أقدم، الـ Worker مش هيحفظ أي حاجة، وده آمن بس من غير فايدة. وقتها حدّث التاريخ لتاريخ
   النهارده: الكود ده بيستخدم `fetch` و`Headers` و`URL` و`Response` و`caches` بس.
3. **الباك:** `CLOUDFLARE_PURGE_CUSTOM_DOMAINS=true` (و`CLOUDFLARE_PURGE_ENABLED=true` موجود
   أصلًا)، وبعدها redeploy. الـ token محتاج صلاحية **Zone › Cache Purge › Purge** على
   `zimos.co`، وهي نفس صلاحية الـ purge الحالية. **ومفيش صلاحية جديدة.** احفظ أي حاجة في
   الداشبورد للمتجر التجريبي، والمفروض اللوج يطلع فيه:
   `[cloudflare-purge] purged {"hosts":["<slug>.zimos.co","www.merchant-shop.com"]}`
4. **الستورفرونت:** `STOREFRONT_EDGE_CACHE_CUSTOM_DOMAINS=true` (مع
   `STOREFRONT_EDGE_CACHE_ENABLED=true`)، وبعدها redeploy. **لسه مفيش كاش**، لأن الـ Worker مش
   بيبعت الإشارة. نفس الـ curl بتاع خطوة 1 المفروض يطلع `private` برضه.
5. **الـ Worker:** Settings → Variables and Secrets → Add → Type: **Text** → Name:
   `EDGE_CACHE_ENABLED` → Value: `true` → **Deploy**.
6. **الاختبارات** في قسم 7 كلها. لو أي حاجة سلبية طلعت `HIT` أو `public`، ارجع فورًا بقسم 10.
7. Production بنفس الترتيب بعد ما staging يعدي.

**ممنوع في Cloudflare (مهم):**
- أي Cache Rule جديدة للدومينات الخاصة.
- أي Cache Rule أو Page Rule بـ Cache Everything أو Edge TTL بتطابق `*.up.railway.app` أو `*`.
- توسيع شرط الـ rule الحالية `ends_with(http.host, ".zimos.co")`.
- تشغيل "Ignore query string" أو "Ignore cache-control".

الـ Cache Rule الحالية **تفضل زي ما هي**.

## 7. اختبارات curl

```bash
A=www.store-a.com      # الدومين الأساسي لمتجر A (verified + الشهادة issued)
B=www.store-b.com      # الدومين الأساسي لمتجر B
P=/products/<product>  # منتج موجود في A
h() { curl -s -o /dev/null -D - "$@" | grep -iE '^HTTP|x-zimos-cache|cache-control|cf-ray|age'; }
```

**إيجابي (MISS ← HIT):**
```bash
for i in 1 2 3; do curl -s -o /dev/null -w '%{http_code} zimos=%header{x-zimos-cache} cc=%header{cache-control} ray=%header{cf-ray} ttfb=%{time_starttransfer}s\n' "https://$A$P"; done
```
المتوقع: `MISS` وبعده `HIT` `HIT`. والـ `cache-control` = `public, max-age=0, s-maxage=60, stale-while-revalidate=300`
في التلاتة. الـ TTFB بتاع الـ HIT المفروض يقل بشكل واضح. الـ Cache API بيشتغل لكل data center
لوحده، وآخر جزء في الـ `cf-ray` هو اسم الـ data center. لو اتغير بين طلب والتاني، أول طلب على كل
data center هيبقى MISS.

**نفي، ولازم يتعمل GET مرتين.** الـ HEAD عمره ما بيملا الكاش، فمش بيثبت حاجة هنا:
```bash
h "https://$A$P" -H 'cookie: zimos_store_locale=en'        # BYPASS + private (مرتين)
h "https://$A$P" -H 'cookie: zimos_store_color_mode=dark'  # BYPASS + private
h "https://$A/cart"                                        # MISS + private (عمره ما يبقى HIT)
h "https://$A/pay/<order-id>"                              # MISS + private
h "https://$A/checkout"                                    # MISS + private
h "https://$A$P" -H 'RSC: 1'                               # BYPASS
h "https://$A$P?_rsc=abc12"                                # BYPASS
h "https://$A$P?storePreview=x"                            # BYPASS
```

**متجر تاني على نفس الدومين، ونفس الـ path على دومين متجر تاني:**
```bash
# مسار داخلي لمتجر B على دومين A: بيتعمله render زي النهارده، بس عمره ما بيتحفظ
h "https://$A/store/<slug-B>"            # MISS + private (مرتين)
# نفس الـ path على B بعد ما A اتكاش: المحتوى بتاع B، وأول مرة MISS
curl -s "https://$A$P" | grep -o '<title>[^<]*'
curl -s -o /dev/null -w 'zimos=%header{x-zimos-cache}\n' "https://$B$P"   # MISS (مش HIT من A)
curl -s "https://$B$P" | grep -o '<title>[^<]*'                           # عنوان B
```

**الدومين غير الأساسي، والـ subdomain:**
```bash
h "https://shop.store-a.com$P"   # 307 للأساسي، من غير public
h "https://<slug-A>.zimos.co$P"  # 307 للدومين الخاص لو الـ redirect شغال، ولو مش شغال يمشي على الـ Cache Rule زي الأول
```

**`robots.txt` وملفات المتجر (من غير أي فلاج):**
```bash
for H in "$A" "$B"; do
  echo "== $H"
  curl -s "https://$H/robots.txt" | grep -i sitemap       # لازم يكون الدومين ده نفسه، مش التاني
  curl -s -o /dev/null -D - "https://$H/robots.txt" | grep -iE 'cf-cache-status|age|x-zimos-cache'   # مش HIT، ومن غير x-zimos-cache
  curl -s "https://$H/sitemap.xml" | grep -o '<loc>[^<]*' | head -2   # روابط الدومين ده
done
```
اعمل اللوب مرتين ورا بعض. سطر `Sitemap:` لازم يفضل دايمًا دومين نفس الـ host.

**الـ purge:**
```bash
curl -s -o /dev/null -w 'zimos=%header{x-zimos-cache}\n' "https://$A$P"   # HIT
# غيّر اسم المنتج أو سعره من الداشبورد، واستنى 3–5 ثواني
# لوج الباك: [cloudflare-purge] purged {"hosts":["<slug-A>.zimos.co","www.store-a.com"]}
curl -s -o /dev/null -w 'zimos=%header{x-zimos-cache}\n' "https://$A$P"   # MISS، وبالمحتوى الجديد
```
لو فضل `HIT` بعد سطر الـ `purged`، يبقى الـ purge بالـ hostname مش بيوصل لنسخ الـ Cache API على
الـ zone دي. بص على الحد 9.3، والصفحة هتتحدث خلال `s-maxage` (60 ثانية).

## 8. الاختبارات الآلية

**Frontend** (من `zimos-frontend`):
```bash
npm ci
npm run test:worker                                   # الـ Worker: 20 تست
cd apps/storefront
npm run test:components                               # vitest: 1008 تست (82 ملف)
npm test                                              # node --test: 172 تست
npx tsc --noEmit && npx eslint src/proxy.ts src/lib/edgeCache.ts src/lib/edgeHost.ts
```

- **`worker/custom-domains-worker.test.mjs`:**
  - الفلاج مقفول: نفس الـ forward بالظبط، من غير قراءة كاش ولا إشارة ولا label. والـ
    `x-zimos-edge-cache` اللي جاي من الزائر بيتشال.
  - MISS ← HIT
  - متجرين على نفس الـ path = مفتاحين، ومفيش أي مفتاح على host بتاع Railway
  - الـ query جزء من المفتاح
  - `Cache-Control` مش بيتلمس
  - `/cart` و`/pay` و`/checkout` عمرهم ما بيتحفظوا
  - مفيش حفظ لـ Set-Cookie أو 404 أو 307 أو RSC أو mark مختلف أو `private`
  - الكوكيز = BYPASS من غير إشارة، و`zimos_touch` = HIT
  - RSC و`_rsc` والـ previews وRange وAuthorization = BYPASS
  - الـ assets والـ POST زي الأول
  - HEAD
  - **ملفات المتجر (قسم 4.4):**
    - الـ test بيقرا `STORE_FILES` من `proxy.ts` نفسه، فلو اتضاف ملف جديد هناك الـ test بيقع لحد
      ما الـ Worker يغطيه.
    - كل ملف منهم بـ `cache: "no-store"` والفلاج مقفول وشغال، على دومينين ومعاه query. وباقي
      الطلب زي ما هو: الـ host والسر والـ IP، من غير إشارة ولا label ولا Cache API.
    - الكتابات التانية: `/ROBOTS.TXT` و`/robots%2Etxt`.
    - الملفات التانية زي ما هي: `/_next/static` والصور و`/favicon.ico` و`/robots.txt.bak`
      و`/blog/robots.txt`.
    - runtime من غير `cache` = `cf.cacheTtl: -1`.
  - الكاش لو وقع ما يوقعش الطلب
  - runtime من غير `no-store` = ولا حاجة بتتحفظ
- **`src/lib/edgeCache.test.tsx`:**
  - `merchantPage`: الفلاجين، السر، الإشارة، host = primary بالظبط، port
  - slug غلط في الـ rewrite = مفيش mark
  - نفس قواعد الـ subdomain
  - الإشارة على الـ subdomain = مفيش mark
- **`src/proxy.test.tsx`:**
  - الفلاج مقفول (فاضي، `false`، `1`، `TRUE`) = زي الأول بالظبط
  - متجرين ودومينين، كل واحد بيروح لمتجره
  - من غير إشارة أو من غير سر = مفيش mark
  - دومين غير أساسي (307)، و`primaryHost` null، وhost مش معروف
  - الكوكيز
  - `/pay` و`/cart` و`/checkout` و`/account` و`/orders` و`/track` و`/offer` و`/f` والـ home funnel
  - مسار داخلي لمتجر تاني
  - preview، POST، الـ internal path
  - `STOREFRONT_EDGE_CACHE_ENABLED` مقفول
  - الإشارة مش بتوصل للـ app

**Backend** (من `zimos`، على DB خاصة، مش `zimos_dev`، ومن غير ما ألمس `.env`):
```bash
createdb zimos_cfcd_test
NODE_ENV=test DB_NAME_TEST=zimos_cfcd_test DB_PASSWORD=… npx sequelize-cli db:migrate
NODE_ENV=test DB_NAME_TEST=zimos_cfcd_test DB_PASSWORD=… npx jest --runInBand \
  tests/unit/cloudflarePurge.test.js tests/integration/cloudflarePurge.test.js
```

- **unit:**
  - الفلاج مقفول: الـ subdomain بس، ومفيش قراءة لجدول `domains`
  - شغال: الـ subdomain والدومين في طلب واحد بعد نفس الـ debounce
  - متجر عمره ما بيمسح دومين متجر تاني
  - القديم والجديد (إزالة، وتبديل الأساسي)
  - `customHost` بترفض الـ platform والـ CNAME target والـ IP والـ apex والـ port والـ path
  - الحد 30 host للطلب بنفس الـ bucket
  - DB وقعت = warning والـ subdomain بيتمسح برضه
- **integration (DB حقيقية + Cloudflare mock):**
  - تعديل بيمسح الـ subdomain ودومين نفس المتجر بس
  - DELETE للدومين بيمسحه
  - PATCH بـ `isPrimary` بيمسح القديم والجديد
  - claim pending على host متجر تاني عمره ما بيتمسح
  - الفلاج مقفول = الـ subdomain بس

  وكمان عدّوا التستات دي من غير ما يتكسر حاجة: `customDomains` و`domainJobs` و`domainProviderOrphans`
  و`domainsHostnameMigration` و`storeDomains` و`cloudflareCertificates` و`storefront`
  و`publicCaching` و`storeSuspension` و`auditIntegrity` و`workspaceSlugApi` و`envSecrets`
  و`hostResolverPrivateHost`.

**Mutation checks:** كسرت كل شرط من دول عن قصد، والتستات وقعت في كل مرة (ومعاهم إصلاح ملفات
المتجر: 4 تستات وقعت من غيره):
- الفلاج دايمًا شغال
- شيل فحص الـ slug
- شيل فحص الـ primary host
- شيل فحص status في الـ previousHosts
- شيل فحص الـ CNAME target

## 9. الحدود المعروفة

1. **`robots.txt` على الدومينات الخاصة: اتصلح (قسم 4.4).** اللي لسه محتاج تأكيد:
   - التسريب نفسه ماقدرتش أشوفه من الـ sandbox، ومبني على التوثيق اللي بيقول إن `robots.txt` بيتكاش
     افتراضيًا.
   - بديل `cf.cacheTtl: -1` (لـ runtime قديم) جاي من أمثلة ومن الـ community، مش من صفحة الـ reference.
   - أي ملف جديد بيتولد لكل متجر لازم يتضاف لـ `STORE_FILES` في الـ proxy، والـ test بتاع الـ Worker
     بيقع لحد ما الـ Worker يغطيه.
   - Next.js بيكاش الملفات دي جوه الستورفرونت لكل متجر لوحده (`revalidate`)، فطلبها من Railway كل
     مرة رخيص.
2. **الـ Cache API بيشتغل لكل data center لوحده، ومش tiered:**
   - كل data center بيتملى لوحده، فالـ hit ratio أقل من الـ subdomain.
   - كل طلب لسه بيشغّل الـ Worker زي النهارده، فعدد طلبات الـ Workers مش بيقل. التوفير في
     الـ render على Railway والـ TTFB.
3. **الـ purge بالـ hostname ونسخ الـ Cache API:** نتايج البحث بتقتبس صفحة *How the cache
   works* إن الـ purge بالـ host (وكمان tag وprefix وeverything) بيشتغل على الـ assets اللي
   اتحفظت بالـ Cache API، بس ماقدرتش أفتح الصفحة نفسها. **اتأكد على staging** بقسم 7 (الـ purge).
   ولو مش شغال، أقصى قِدم = `s-maxage` (60 ثانية)، لأن الـ Cache API مش بيدعم SWR.
4. **مفيش `stale-while-revalidate`:** *"The stale-while-revalidate and stale-if-error directives
   are not supported when using the cache.put or cache.match methods."* بعد `s-maxage` أول زائر
   بيستنى الـ render.
5. **`s-maxage` في الـ Cache API:** الافتراض إنه بيمشي على قواعد Cloudflare (`s-maxage` أقوى من
   `max-age=0` في الكاش المشترك). لو طلع `MISS` على طول على staging مع إن الإشارة رايحة، يبقى
   الـ put بيرفض بسبب `max-age=0`. والنتيجة وقتها: ولا حاجة بتتكاش، وده آمن. وهيبقى محتاج
   قرار تاني، زي `Cloudflare-CDN-Cache-Control`، وده مش متطبق.
6. **الدومين الأساسي بس هو اللي بيتكاش:** الدومين غير الأساسي بيعمل 307، و`redirectToPrimary=false`
   مش بيتكاش.
7. **HEAD** بيتقرا من الكاش بس عمره ما بيملاه.
8. **نقل دومين بين متجرين:** الستورفرونت بيفتكر رد `resolve-host` لمدة دقيقة. بس الإزالة بتمسح
   الـ custom hostname من Cloudflare (`revokeCertificate`)، فالدومين مش بيوصل للـ Worker أصلًا لحد
   ما شهادة المتجر الجديد تطلع (دقايق). وبعدها الـ purge بيتعمل للقديم والجديد. يعني عمليًا مفيش
   نافذة.
9. **`X-Zimos-Cache`** بيظهر للزوار (HIT/MISS/BYPASS)، وده للتشخيص بس ومفيهوش أي سر.
10. **compatibility date:** لو قديم، الميزة بتتقفل لوحدها (قسم 6، خطوة 2).
11. **ماقدرتش أتأكد** هل `*.up.railway.app` على Cloudflare zone ولا لأ. ومش فارقة للصفحات
    المحفوظة ولا لملفات المتجر بسبب `no-store`.
12. **مصادر Cloudflare** جاية من نتايج بحث بتقتبس التوثيق، لأن `developers.cloudflare.com` و
    `blog.cloudflare.com` مقفولين في الـ sandbox. عشان كده خطوات staging في قسم 7 إلزامية قبل
    الإنتاج.

## 10. خطة الرجوع (rollback)

بالترتيب من الأسرع:

1. **الـ Worker:** امسح `EDGE_CACHE_ENABLED` أو خليه `false` وبعدها Deploy. **فورًا** مفيش نسخة
   محفوظة بتتقري، ولا إشارة بتتبعت، فكل الطلبات بترجع للسلوك القديم. النسخ اللي اتحفظت بتخلص
   لوحدها خلال `s-maxage`.
2. **الستورفرونت:** `STOREFRONT_EDGE_CACHE_CUSTOM_DOMAINS=false` وبعدها redeploy. مفيش mark جديد،
   والـ Worker بيخدم النسخ الموجودة لحد ما تخلص (60 ثانية بالكتير).
3. **مسح فوري:** Cloudflare → Caching → Configuration → Custom Purge → Hostname →
   `www.merchant-shop.com`، أو بالـ API:
   ```bash
   curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/purge_cache" \
     -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
     --data '{"hosts":["www.merchant-shop.com"]}'
   ```
4. **كود الـ Worker:** Workers & Pages → `zimos-custom-domains` → Deployments → النسخة اللي
   قبلها → Rollback. الكود القديم مش بيعرف الكاش خالص.
   ⚠️ ده **بيرجّع تسريب `robots.txt`** (قسم 4.4)، لأن الإصلاح مالوش فلاج. عشان كده استخدم خطوة 1
   الأول، والـ rollback الكامل للكود يبقى آخر حل.
5. **الباك:** `CLOUDFLARE_PURGE_CUSTOM_DOMAINS=false`، فيرجع يمسح الـ subdomain بس.
6. **الكود:** revert للـ commits بتاعة قسم 11. الفلاجات المقفولة كفاية من غير revert.

## 11. الـ commits

`zimos-frontend` (branch `claude/friendly-meitner-e0kaum`):
- Worker: keep merchant-domain pages under the visitor's own URL (EDGE_CACHE_ENABLED)
- Storefront: edge-cache merchant domains' public pages (STOREFRONT_EDGE_CACHE_CUSTOM_DOMAINS)
- Docs: merchant domains at the edge, and this report
- Worker: never let Cloudflare keep a store's own files under the Railway URL (robots.txt fix)

`zimos` (branch `claude/friendly-meitner-e0kaum`):
- Purge: merchant domains with the store's subdomain (CLOUDFLARE_PURGE_CUSTOM_DOMAINS)
- Docs: this report
- Docs: report — the robots.txt fix

## المصادر

- [How the Cache works · Cloudflare Workers docs](https://developers.cloudflare.com/workers/reference/how-the-cache-works/)
- [Cache (Cache API) · Cloudflare Workers docs](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [Cache using fetch · Cloudflare Workers docs](https://developers.cloudflare.com/workers/examples/cache-using-fetch/) (`cf.cacheKey` Enterprise)
- [Workers Cache · Cloudflare Workers docs](https://developers.cloudflare.com/workers/cache/)
- [Default cache behavior · Cloudflare Cache docs](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/) (HTML مش بيتكاش افتراضيًا، و`robots.txt` بيتكاش)
- [Gist: `cf: { cacheTtl: -1 }` to never cache](https://gist.github.com/shagamemnon/4041f6155ecce15440234d28fa749c32)
- [Community: negative TTLs in `cacheTtlByStatus` stopped caching](https://community.cloudflare.com/t/worker-cache-is-shorter-than-specified/454997)
- [Workers: bypass caching for subrequests with Request.cache](https://community.cloudflare.com/t/workers-bypass-caching-for-subrequests-made-from-cloudflare-workers-with-request-cache/897333)
- [All cache purge methods now available for all plans](https://developers.cloudflare.com/changelog/post/2025-04-01-purge-for-all/)
