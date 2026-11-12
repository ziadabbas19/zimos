'use strict';

const { Router } = require('express');
const { publicCatalog } = require('./fontCatalog');

/*
 * GET /api/v1/fonts — the font catalog (fontCatalog.js), for the dashboard's
 * pickers and the storefront. No sign-in: it names public Google Fonts
 * families and nothing about any store. It only changes with a deploy, so
 * browsers and the storefront may keep it for an hour and serve a stale copy
 * for a day while they fetch a new one.
 */
const router = Router();

router.get('/', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  res.json(publicCatalog());
});

module.exports = { router };
