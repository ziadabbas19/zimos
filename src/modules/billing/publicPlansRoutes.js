'use strict';

const { Router } = require('express');
const asyncHandler = require('express-async-handler');
const { publicPlansLimiter } = require('../../core/middleware/rateLimiters');
const { listPublicPlans } = require('./publicPlansService');

// Mounted at /api/v1/plans. No sign-in: the marketing site's pricing page and
// the sign-up form read it. Limited per IP, and cacheable for a minute.
const router = Router();

router.get(
  '/public',
  publicPlansLimiter,
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json(await listPublicPlans());
  })
);

module.exports = router;
