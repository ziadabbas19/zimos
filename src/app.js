'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const swaggerUi = require('swagger-ui-express');
const env = require('./config/env');
const requestId = require('./core/middleware/requestId');
const { generalLimiter } = require('./core/middleware/rateLimiters');
const { errorHandler, notFoundHandler } = require('./core/middleware/errorHandler');
const { hostResolver } = require('./core/middleware/hostResolver');
const logger = require('./core/utils/logger');
const db = require('./db/models');

const authRoutes = require('./modules/auth/authRoutes');
const workspaceRoutes = require('./modules/workspaces/workspaceRoutes');
const catalogRoutes = require('./modules/catalog/catalogRoutes');
const inventoryRoutes = require('./modules/inventory/inventoryRoutes');
const customerRoutes = require('./modules/customers/customerRoutes');
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
const adminRoutes = require('./modules/billing/adminRoutes');
const domainsRoutes = require('./modules/domains/domainsRoutes');
const mediaRoutes = require('./modules/media/mediaRoutes');
const reviewRoutes = require('./modules/reviews/reviewRoutes');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

// EJS view engine for the built-in storefront viewer.
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(requestId);
app.use(helmet());
app.use(
  cors({
    origin: env.cors.origins,
    credentials: true,
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

if (!env.isTest) {
  app.use((req, res, next) => {
    logger.info(`${req.method} ${req.originalUrl}`, { requestId: req.id, ip: req.ip });
    next();
  });
}

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
app.use('/uploads', express.static(path.join(__dirname, '..', 'public', 'uploads'), { fallthrough: true, maxAge: '1h' }));

// --- Storefront host routing (subdomain / custom domain -> /shop/:id) -----
// Runs after /health so monitoring works on any host; before all route mounts.
app.use(hostResolver);

// --- API v1 --------------------------------------------------------------
const v1 = express.Router();
v1.use('/auth', authRoutes);
// Must be registered BEFORE the generic '/workspaces' mount: workspaceRoutes
// runs the strict `authenticate` for every path under '/workspaces', which
// would reject the quickstart query-string / hidden-field token before it
// reaches this router's `authenticateFlexible`.
v1.use('/workspaces/:workspaceId/quickstart', quickstartRoutes);
v1.use('/workspaces', workspaceRoutes);
v1.use('/workspaces/:workspaceId/catalog', catalogRoutes);
v1.use('/workspaces/:workspaceId/inventory', inventoryRoutes);
v1.use('/workspaces/:workspaceId/customers', customerRoutes);
v1.use('/workspaces/:workspaceId/orders', orderRoutes);
v1.use('/workspaces/:workspaceId/returns', returnRoutes);
v1.use('/workspaces/:workspaceId/confirmation-tasks', confirmationRoutes);
v1.use('/workspaces/:workspaceId', paymentRoutes);
v1.use('/workspaces/:workspaceId/discounts', discountRoutes);
v1.use('/workspaces/:workspaceId/shipping', shippingRoutes);
v1.use('/workspaces/:workspaceId/tax-rates', taxRoutes);
v1.use('/workspaces/:workspaceId/websites', pagesRoutes);
v1.use('/workspaces/:workspaceId/funnels', funnelsRoutes);
v1.use('/workspaces/:workspaceId/domains', domainsRoutes);
v1.use('/workspaces/:workspaceId/media', mediaRoutes);
v1.use('/workspaces/:workspaceId/reviews', reviewRoutes);
v1.use('/billing', billingRoutes);
v1.use('/admin', adminRoutes);

// --- Public storefront (no staff auth) ------------------------------------
v1.use('/store/:workspaceId/pages', pagesPublicRoutes);
v1.use('/store/:workspaceId/funnels', funnelsPublicRoutes);
v1.use('/store/:workspaceId', storefrontRoutes);
v1.use('/store/:workspaceId/cart', cartRoutes);

app.use(`/api/${env.apiVersion}`, v1);

// --- Public server-rendered storefront (HTML, no staff auth) -------------
app.use('/shop/:workspaceId', quickstartPublicRoutes);

// --- API documentation ----------------------------------------------------
const openapiSpec = require('../docs/openapi.json');
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));
app.get('/docs.json', (req, res) => res.json(openapiSpec));

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
