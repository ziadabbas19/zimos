'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const swaggerUi = require('swagger-ui-express');
const env = require('./config/env');
const requestId = require('./core/middleware/requestId');
const { resolveClientIp, clientIp } = require('./core/middleware/clientIp');
const { corsPolicy } = require('./core/middleware/cors');
const { generalLimiter, storefrontLimiter, carrierWebhookLimiter, paymentWebhookLimiter, deliveryWebhookLimiter } = require('./core/middleware/rateLimiters');
const { errorHandler, notFoundHandler } = require('./core/middleware/errorHandler');
const { whenAiEnabled } = require('./modules/ai/aiGate');
const { hostResolver } = require('./core/middleware/hostResolver');
const logger = require('./core/utils/logger');
const { redactUrl } = require('./core/utils/redactUrl');
const db = require('./db/models');

const authRoutes = require('./modules/auth/authRoutes');
const workspaceRoutes = require('./modules/workspaces/workspaceRoutes');
const catalogRoutes = require('./modules/catalog/catalogRoutes');
const inventoryRoutes = require('./modules/inventory/inventoryRoutes');
const customerRoutes = require('./modules/customers/customerRoutes');
const contactRoutes = require('./modules/contacts/contactRoutes');
const dashboardRoutes = require('./modules/dashboard/dashboardRoutes');
const digitalRoutes = require('./modules/digital/digitalRoutes');
const serviceListingRoutes = require('./modules/serviceListings/serviceListingRoutes');
const shoppableImageRoutes = require('./modules/shoppableImages/shoppableImageRoutes');
const courseRoutes = require('./modules/courses/courseRoutes');
const orderRoutes = require('./modules/orders/orderRoutes');
const returnRoutes = require('./modules/returns/returnRoutes');
const confirmationRoutes = require('./modules/cod/confirmationRoutes');
const paymentRoutes = require('./modules/payments/paymentRoutes');
const discountRoutes = require('./modules/discounts/discountRoutes');
const shippingRoutes = require('./modules/shipping/shippingRoutes');
const taxRoutes = require('./modules/tax/taxRoutes');
const storefrontRoutes = require('./modules/storefront/storefrontRoutes');
const cartRoutes = require('./modules/cart/cartRoutes');
const pagesRoutes = require('./modules/pages/pagesRoutes');
const pagesPublicRoutes = require('./modules/pages/pagesPublicRoutes');
const funnelsRoutes = require('./modules/funnels/funnelsRoutes');
const funnelsPublicRoutes = require('./modules/funnels/funnelsPublicRoutes');
const quickstartRoutes = require('./modules/quickstart/quickstartRoutes');
const quickstartPublicRoutes = require('./modules/quickstart/quickstartPublicRoutes');
const billingRoutes = require('./modules/billing/billingRoutes');
const publicPlansRoutes = require('./modules/billing/publicPlansRoutes');
const workspaceBillingRoutes = require('./modules/billing/workspaceBillingRoutes');
const adminRoutes = require('./modules/billing/adminRoutes');
const paymentAdminRoutes = require('./modules/billing/paymentAdminRoutes');
const platformAdminRoutes = require('./modules/platformAdmin/platformAdminRoutes');
const domainsRoutes = require('./modules/domains/domainsRoutes');
const mediaRoutes = require('./modules/media/mediaRoutes');
const reviewRoutes = require('./modules/reviews/reviewRoutes');
const fraudRoutes = require('./modules/fraud/fraudRoutes');
const supportRoutes = require('./modules/support/supportRoutes');
const checkoutSessionRoutes = require('./modules/checkoutSessions/checkoutSessionRoutes');
const templateRoutes = require('./modules/templates/templateRoutes');
const carrierRoutes = require('./modules/shipping/carrierRoutes');
const carrierWebhookRoutes = require('./modules/shipping/carrierWebhookRoutes');
const onlinePaymentRoutes = require('./modules/payments/onlinePaymentRoutes');
const paymentWebhookRoutes = require('./modules/payments/paymentWebhookRoutes');
const analyticsRoutes = require('./modules/analytics/analyticsRoutes');
const eventsPublicRoutes = require('./modules/analytics/eventsPublicRoutes');
const siteEventsRoutes = require('./modules/siteAnalytics/siteEventsRoutes');
const auditRoutes = require('./modules/audit/auditRoutes');
const invoiceRoutes = require('./modules/invoices/invoiceRoutes');
const whatsappRoutes = require('./modules/whatsapp/whatsappRoutes');
const automationRoutes = require('./modules/automations/automationRoutes');
const settlementRoutes = require('./modules/settlements/settlementRoutes');
const profitRoutes = require('./modules/profit/profitRoutes');
const serverPixelsRoutes = require('./modules/marketing/serverPixelsRoutes');
const apiKeyRoutes = require('./modules/apiKeys/apiKeyRoutes');
const webhookRoutes = require('./modules/webhooks/webhookRoutes');
const publicApiRoutes = require('./modules/publicApi/publicApiRoutes');
const merchantNotificationRoutes = require('./modules/notifications/merchantNotificationRoutes');
const trackingPixelRoutes = require('./modules/marketing/trackingPixelRoutes');
const inboxRoutes = require('./modules/whatsapp/inboxRoutes');
const orderEmailRoutes = require('./modules/notifications/orderEmailRoutes');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

// EJS view engine for the built-in storefront viewer.
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(requestId);
// The client IP, once, before the request log and the rate limits read it.
app.use(resolveClientIp);
app.use(helmet());
// Any origin for the public /api/v1/store API, the CORS_ORIGINS allowlist
// everywhere else (see core/middleware/cors.js).
app.use(corsPolicy);
// Responses of 1 KB and more go out compressed when the client asks: brotli
// (quality 4, cheap enough per request), else gzip. The live streams (SSE)
// stay as they are: a compressor would hold their events back.
app.use(
  compression({
    filter: (req, res) => {
      if (String(res.getHeader('Content-Type') || '').startsWith('text/event-stream')) return false;
      return compression.filter(req, res);
    },
  })
);
// Storefront analytics beacons get their own, much smaller, body limit. Mounted
// before the API-wide parser below, which then skips the already-read body.
app.use(`/api/${env.apiVersion}/store/:workspaceId/events`, eventsPublicRoutes.eventsBodyParser);
// The marketing site's anonymous beacon reads its own 2kb body and has its own
// per-IP limit; off, the path answers 404 (siteAnalytics/).
app.use(siteEventsRoutes.PATH, siteEventsRoutes);
// `verify` keeps the exact bytes Express parsed so webhook signatures can be
// checked against what the gateway actually signed — a re-serialised req.body
// would differ by key order or whitespace and never match. See
// modules/billing/gatewaySignature.js.
app.use(
  express.json({
    limit: '2mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

if (!env.isTest) {
  app.use((req, res, next) => {
    // Gateway callbacks carry their signature in the query string (?hmac=):
    // it never reaches a log line.
    logger.info(`${req.method} ${redactUrl(req.originalUrl)}`, { requestId: req.id, ip: clientIp(req) });
    next();
  });
}

// The public storefront API is limited per shopper rather than per IP (see
// rateLimiters.js); generalLimiter skips whatever this limiter handled.
app.use(`/api/${env.apiVersion}/store`, storefrontLimiter);
// Courier webhooks all come from the courier's servers: limited per merchant
// webhook token, not per IP (see rateLimiters.js).
app.use(`/api/${env.apiVersion}/webhooks/carriers`, carrierWebhookLimiter);
app.use(`/api/${env.apiVersion}/webhooks/payments`, paymentWebhookLimiter);
// Email and SMS delivery status webhooks: per provider, not per IP (rateLimiters.js).
app.use([`/api/${env.apiVersion}/webhooks/email`, `/api/${env.apiVersion}/webhooks/sms`], deliveryWebhookLimiter);
app.use(generalLimiter);

// --- Health / readiness -----------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/health/ready', async (req, res) => {
  try {
    await db.sequelize.authenticate();
    res.json({ status: 'ready', database: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'not_ready', database: 'disconnected' });
  }
});

// --- Uploaded media (local disk, no CDN) --------------------------------
// Files written by POST /workspaces/:id/media are served straight from
// public/uploads so the returned URL works directly in logoUrl/imageUrl.
// helmet() sends Cross-Origin-Resource-Policy: same-origin on everything, which
// stops the dashboard and the stores (other origins) from showing these public
// images at all, so they are marked cross-origin here.
app.use(
  '/uploads',
  express.static(path.join(__dirname, '..', 'public', 'uploads'), {
    fallthrough: true,
    maxAge: '1h',
    setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'),
  })
);

// --- Storefront host routing (subdomain / custom domain -> /shop/:id) -----
// Runs after /health so monitoring works on any host; before all route mounts.
app.use(hostResolver);

// --- API v1 --------------------------------------------------------------
const v1 = express.Router();
v1.use('/auth', authRoutes);
// The signed-in account's devices for device notifications (PUSH_ENABLED; off, 404).
v1.use('/me/push', require('./modules/notifications/push/pushRoutes'));
// The link in an invite email: read without an account, accepted signed in.
v1.use('/invites', require('./modules/workspaces/inviteRoutes'));
// Public template gallery — no auth, shown before a workspace even exists.
v1.use('/templates', templateRoutes);
// Must be registered BEFORE the generic '/workspaces' mount: workspaceRoutes
// runs the strict `authenticate` for every path under '/workspaces', which
// would reject the quickstart query-string / hidden-field token before it
// reaches this router's `authenticateFlexible`.
v1.use('/workspaces/:workspaceId/quickstart', quickstartRoutes);
v1.use('/workspaces', workspaceRoutes);
v1.use('/workspaces/:workspaceId/catalog', catalogRoutes);
v1.use('/workspaces/:workspaceId/inventory', inventoryRoutes);
v1.use('/workspaces/:workspaceId/customers', customerRoutes);
v1.use('/workspaces/:workspaceId/contacts', contactRoutes.staff);
v1.use('/service-listings', serviceListingRoutes.merchant);
v1.use('/admin/service-listings', serviceListingRoutes.admin);
v1.use('/workspaces/:workspaceId/digital', digitalRoutes.staff);
v1.use('/workspaces/:workspaceId/shoppable-images', shoppableImageRoutes.staff);
v1.use('/workspaces/:workspaceId/courses', courseRoutes.staff);
v1.use('/workspaces/:workspaceId', dashboardRoutes);
v1.use('/workspaces/:workspaceId/orders', orderRoutes);
v1.use('/workspaces/:workspaceId/exports', require('./modules/orders/exportFileRoutes'));
v1.use('/workspaces/:workspaceId/account-settings', require('./modules/workspaces/accountSettings').router);
v1.use('/workspaces/:workspaceId/saved-views', require('./modules/workspaces/savedViews').router);
v1.use('/workspaces/:workspaceId/returns', returnRoutes);
v1.use('/workspaces/:workspaceId/confirmation-tasks', confirmationRoutes);
v1.use('/workspaces/:workspaceId', paymentRoutes);
v1.use('/workspaces/:workspaceId/discounts', discountRoutes);
v1.use('/workspaces/:workspaceId/bundles', require('./modules/bundles/bundleRoutes'));
v1.use('/workspaces/:workspaceId/offers', require('./modules/offers/offersRoutes'));
// Product feeds for ad channels: /feeds/:workspaceSlug/:channel.xml|csv (public, no auth).
v1.use('/feeds', require('./modules/offers/productFeed').publicRouter);
// Before the shipping router: shipping groups (shipping/shippingProfiles.js).
v1.use('/workspaces/:workspaceId/shipping/profiles', require('./modules/shipping/shippingProfiles').router);
v1.use('/workspaces/:workspaceId/shipping/options', require('./modules/shipping/shippingOptions').router);
v1.use('/workspaces/:workspaceId/shipping', shippingRoutes);
v1.use('/workspaces/:workspaceId/tax-rates', taxRoutes);
v1.use('/workspaces/:workspaceId/websites', pagesRoutes);
v1.use('/workspaces/:workspaceId/funnels', funnelsRoutes);
v1.use('/workspaces/:workspaceId/domains', domainsRoutes);
// The theme catalog for this store (themes/themesCatalog.js).
v1.use('/workspaces/:workspaceId/themes', require('./modules/themes/themesCatalog').router);
// Page sections saved for reuse across pages and funnels (website.edit).
v1.use('/workspaces/:workspaceId/saved-sections', require('./modules/savedSections/savedSectionsRoutes'));
// Split tests on funnel steps (funnels.manage).
v1.use('/workspaces/:workspaceId/experiments', require('./modules/funnels/splitTests').router);
v1.use('/workspaces/:workspaceId/product-tests', require('./modules/catalog/productTests').router);
// Translations of the merchant's own content, and the languages overview (website.edit).
v1.use('/workspaces/:workspaceId/translations', require('./modules/translations/translations').router);
// The AI features and the WhatsApp bot's staff routes: there only while AI_ENABLED is "true" (modules/ai/aiGate.js).
v1.use('/workspaces/:workspaceId/ai', whenAiEnabled(require('./modules/ai/aiRoutes')));
v1.use('/workspaces/:workspaceId/wa-bot', whenAiEnabled(require('./modules/whatsapp/bot/botService').router));
v1.use('/workspaces/:workspaceId/media', mediaRoutes);
v1.use('/workspaces/:workspaceId/reviews', reviewRoutes);
// Combos: different products sold together at one price (modules/combos, PRODUCT_COMBOS_ENABLED).
v1.use('/workspaces/:workspaceId/combos', require('./modules/combos/comboRoutes').staff);
v1.use('/workspaces/:workspaceId/fraud', fraudRoutes);
v1.use('/workspaces/:workspaceId/support', supportRoutes);
v1.use('/workspaces/:workspaceId/billing', workspaceBillingRoutes);
v1.use('/workspaces/:workspaceId/checkout-sessions', checkoutSessionRoutes);
v1.use('/workspaces/:workspaceId/carriers', carrierRoutes);
v1.use('/workspaces/:workspaceId/shipment-batches', require('./modules/shipping/bulkShipRoutes'));
v1.use('/workspaces/:workspaceId/payments', onlinePaymentRoutes);
v1.use('/workspaces/:workspaceId/manual-payments', require('./modules/manualPayments/manualPaymentRoutes'));
v1.use('/workspaces/:workspaceId/analytics', analyticsRoutes);
v1.use('/workspaces/:workspaceId/audit-logs', auditRoutes);
v1.use('/workspaces/:workspaceId/invoices', invoiceRoutes);
v1.use('/workspaces/:workspaceId/whatsapp', whatsappRoutes.staff);
v1.use('/workspaces/:workspaceId/automations', automationRoutes);
v1.use('/workspaces/:workspaceId/settlements', settlementRoutes);
// A store's own couriers (self delivery).
v1.use('/workspaces/:workspaceId/couriers', require('./modules/couriers/couriersRoutes'));
// Delivery zones inside a city (self delivery).
v1.use('/workspaces/:workspaceId/delivery-zones', require('./modules/shipping/deliveryZoneRoutes'));
// A product's menu options (option groups and choices).
v1.use('/workspaces/:workspaceId/product-options/:productId', require('./modules/catalog/menuOptionsRoutes'));
// A store's suggestions to the platform (Help → Suggest a feature).
v1.use('/workspaces/:workspaceId/suggestions', require('./modules/suggestions/suggestionRoutes'));
v1.use('/workspaces/:workspaceId/store-credit', require('./modules/storeCredit').staff);
v1.use('/workspaces/:workspaceId/vip-tiers', require('./modules/vipTiers').staff);
v1.use('/workspaces/:workspaceId/loyalty', require('./modules/loyalty').staff);
v1.use('/workspaces/:workspaceId/customer-referrals', require('./modules/customerReferrals').staff);
v1.use('/workspaces/:workspaceId/shopper-returns', require('./modules/returns/shopperReturns').staff);
v1.use('/workspaces/:workspaceId/rfm', require('./modules/rfm').router);
v1.use('/workspaces/:workspaceId/store-reports', require('./modules/storeReports').router);
v1.use('/workspaces/:workspaceId/scheduled-reports', require('./modules/scheduledReports').router);
v1.use('/workspaces/:workspaceId/shopper-accounts', require('./modules/shopperAccounts').staff);
v1.use('/workspaces/:workspaceId/wishlists', require('./modules/shopperAccounts/wishlist').staff);
v1.use('/workspaces/:workspaceId/blog', require('./modules/blog').staff);
v1.use('/workspaces/:workspaceId/gift-cards', require('./modules/giftCards').staff);
v1.use('/workspaces/:workspaceId/gift-options', require('./modules/giftOptions').staff);
v1.use('/workspaces/:workspaceId/purchase-limits', require('./modules/catalog/purchaseLimits').router);
v1.use('/workspaces/:workspaceId/product-specs', require('./modules/productSpecs').staff);
v1.use('/workspaces/:workspaceId/redirects', require('./modules/urlRedirects').staff);
v1.use('/workspaces/:workspaceId/holiday-mode', require('./modules/holidayMode').router);
v1.use('/workspaces/:workspaceId/preorders', require('./modules/preorders').router);
v1.use('/workspaces/:workspaceId/stock-alerts', require('./modules/stockAlerts').staff);
v1.use('/workspaces/:workspaceId/product-questions', require('./modules/productQuestions').staff);
v1.use('/workspaces/:workspaceId/size-charts', require('./modules/sizeCharts').staff);
v1.use('/workspaces/:workspaceId/profit', profitRoutes);
v1.use('/workspaces/:workspaceId/server-pixels', serverPixelsRoutes.staff);
v1.use('/workspaces/:workspaceId/api-keys', apiKeyRoutes);
v1.use('/workspaces/:workspaceId/webhooks', webhookRoutes);
v1.use('/workspaces/:workspaceId/notifications', merchantNotificationRoutes);
// The store as an app for shoppers: its home-screen name, icon and colour (website.publish).
v1.use('/workspaces/:workspaceId/store-app', require('./modules/storefront/storeApp').router);
v1.use('/workspaces/:workspaceId/tracking-pixels', trackingPixelRoutes);
v1.use('/workspaces/:workspaceId/inbox', inboxRoutes);
v1.use('/workspaces/:workspaceId/order-emails', orderEmailRoutes);
// The store's email suppression list (notifications/deliveryStatus, DELIVERY_STATUS_ENABLED).
v1.use('/workspaces/:workspaceId/email-suppressions', require('./modules/notifications/deliveryStatus/suppressionRoutes'));
// The inbox's live stream (SSE): opened with a short-lived ticket, not a staff session.
v1.use('/inbox-stream', inboxRoutes.stream);
// The analytics live view's SSE stream — opened with a ticket, like the inbox stream.
v1.use('/analytics-stream', require('./modules/analytics/realtimeStream').streamRouter);
// WhatsApp Cloud API webhook — public; Meta's X-Hub-Signature-256 over the raw
// body proves the sender.
v1.use('/webhooks/whatsapp', whatsappRoutes.webhook);
v1.use('/billing', billingRoutes);
// The plans on offer — public, for the marketing site and the sign-up form.
v1.use('/plans', publicPlansRoutes);
// The platform's public details (contact, social links, company, footer) — public, PLATFORM_SETTINGS_ENABLED.
v1.use('/platform-settings', require('./modules/platformSettings/platformSettingsRoutes').publicRouter);
// Courier status webhooks — public; the token in the path is the identity.
v1.use('/webhooks/carriers', carrierWebhookRoutes);
// Payment gateway callbacks — public; the token names the account, the HMAC
// proves the sender.
v1.use('/webhooks/payments', paymentWebhookRoutes);
// Email and SMS delivery status — public; Brevo's secret token / Twilio's signature prove the sender (DELIVERY_STATUS_ENABLED).
v1.use('/webhooks', require('./modules/notifications/deliveryStatus/webhookRoutes').router);
v1.use('/admin', adminRoutes);
// Payment methods and transfer proofs (billing/paymentAdminRoutes).
v1.use('/admin', paymentAdminRoutes);
// Plans, subscriptions, feature flags and announcements. Shares the /admin
// mount with adminRoutes above, which owns /workspaces and /dashboard.
v1.use('/admin', platformAdminRoutes);

// --- Public API (a workspace API key, no staff session) --------------------
// Orders and their statuses for merchants' own integrations; see
// docs/public-api.md. Outbound webhooks are sent by modules/webhooks.
v1.use('/public', publicApiRoutes);
// The same API under the path the spec and other platforms' docs use.
app.use('/api/public/v1', publicApiRoutes);

// --- Public storefront (no staff auth) ------------------------------------
// Which store a custom domain belongs to — before the :workspaceId routes,
// which would otherwise read "resolve-host" as a store.
v1.use('/store/resolve-host', require('./modules/domains/domainSettings').publicRouter);
v1.use('/store/:workspaceId/pages', pagesPublicRoutes);
v1.use('/store/:workspaceId/funnels', funnelsPublicRoutes);
// Storefront visit tracking (page views, cart, checkout, purchase).
v1.use('/store/:workspaceId/events', eventsPublicRoutes);
v1.use('/store/:workspaceId/forms', contactRoutes.store);
v1.use('/store/:workspaceId/downloads', digitalRoutes.store);
v1.use('/store/:workspaceId/shoppable-images', shoppableImageRoutes.store);
v1.use('/store/:workspaceId/learn', courseRoutes.portal);
v1.use('/store/:workspaceId/size-chart', require('./modules/sizeCharts').store);
v1.use('/store/:workspaceId/products/:productId/questions', require('./modules/productQuestions').store);
v1.use('/store/:workspaceId/stock-alerts', require('./modules/stockAlerts').store);
v1.use('/store/:workspaceId/redirects', require('./modules/urlRedirects').store);
v1.use('/store/:workspaceId/specs', require('./modules/productSpecs').store);
v1.use('/store/:workspaceId/gift-cards', require('./modules/giftCards').store);
v1.use('/store/:workspaceId/blog', require('./modules/blog').store);
v1.use('/store/:workspaceId/account/wishlist', require('./modules/shopperAccounts/wishlist').store);
v1.use('/store/:workspaceId/account/store-credit', require('./modules/storeCredit').account);
v1.use('/store/:workspaceId/account/vip', require('./modules/vipTiers').account);
v1.use('/store/:workspaceId/account/loyalty', require('./modules/loyalty').account);
v1.use('/store/:workspaceId/account/referral', require('./modules/customerReferrals').account);
v1.use('/store/:workspaceId/account', require('./modules/shopperAccounts').store);
v1.use('/store/:workspaceId/loyalty', require('./modules/loyalty').store);
v1.use('/store/:workspaceId/referrals', require('./modules/customerReferrals').store);
v1.use('/store/:workspaceId/returns', require('./modules/returns/shopperReturns').store);
v1.use('/store/:workspaceId', storefrontRoutes);
v1.use('/store/:workspaceId/cart', cartRoutes);

// The signed, short-lived link to a shopper's photo that staff open from an
// order (customerUploads/uploadLinks.js). The signature is the credential.
v1.get('/customer-uploads/:uploadId', require('./modules/customerUploads/customerUploadController').readSigned);
// The signed, short-lived link to a payment proof's screenshot that a
// platform admin opens (billing/proofLinks.js). The signature is the credential.
v1.get('/payment-proofs/:proofId/image', require('./modules/billing/paymentController').readProofImage);

app.use(`/api/${env.apiVersion}`, v1);

// --- Public server-rendered storefront (HTML, no staff auth) -------------
app.use('/shop/:workspaceId', quickstartPublicRoutes);

// --- API documentation ----------------------------------------------------
const openapiSpec = require('../docs/openapi.json');
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));
app.get('/docs.json', (req, res) => res.json(openapiSpec));
// The public API (modules/publicApi) has its own description, for merchants'
// developers and partners: docs/public-openapi.json, written by
// scripts/build-public-openapi.js.
const publicOpenapiSpec = require('../docs/public-openapi.json');
app.use('/public-docs', swaggerUi.serveFiles(publicOpenapiSpec), swaggerUi.setup(publicOpenapiSpec, { customSiteTitle: 'ZIMOS Public API' }));
app.get('/public-docs.json', (req, res) => res.json(publicOpenapiSpec));

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
