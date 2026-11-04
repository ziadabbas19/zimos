'use strict';

const express = require('express');
const Joi = require('joi');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const validate = require('../../core/middleware/validate');
const { webVitalsLimiter } = require('../../core/middleware/rateLimiters');
const { AppError } = require('../../core/errors/AppError');

/**
 * POST /store/:workspaceId/vitals: a store page's Core Web Vitals, from the
 * small sample of visits the storefront reports from (its
 * NEXT_PUBLIC_WEB_VITALS_SAMPLE_RATE). Off unless WEB_VITALS_ENABLED is exactly
 * "true": off, 404, and nothing is read or written.
 *
 * A beacon: the answer is 204 at once and the write comes after, and a write
 * that fails is logged, never the page's problem. Nothing about the visitor is
 * kept (migration 741). It reads no store on the way (a typo'd id fails its
 * foreign key), so a page's beacon costs one insert and nothing else, and it has
 * its own small body limit and per-IP limit.
 */

const METRIC_LIMITS = { LCP: 120000, INP: 60000, CLS: 100, TTFB: 120000 };
const ROUTES = ['home', 'listing', 'product', 'cart', 'checkout', 'page', 'other'];
const DEVICES = ['mobile', 'desktop'];

const schema = {
  params: Joi.object({ workspaceId: Joi.string().uuid().required() }),
  body: Joi.object({
    route: Joi.string().valid(...ROUTES).required(),
    device: Joi.string().valid(...DEVICES).required(),
    metrics: Joi.array()
      .items(
        Joi.object({
          name: Joi.string().valid(...Object.keys(METRIC_LIMITS)).required(),
          value: Joi.number().min(0).required(),
        })
      )
      .min(1)
      .max(4)
      .required(),
  }),
};

const bodyParser = express.json({ limit: '2kb', type: ['application/json', 'text/plain'] });

/** A beacon's own small body, read before the API-wide parser. Off: not read at all. */
function vitalsBodyParser(req, res, next) {
  if (!env.webVitals.enabled) return next();
  return bodyParser(req, res, (err) => (err ? next(new AppError('INVALID_BODY', 'The request body is not valid', 400)) : next()));
}

async function save(workspaceId, { route, device, metrics }) {
  const kept = metrics.filter((m) => m.value <= METRIC_LIMITS[m.name]);
  if (kept.length === 0) return;
  await db.sequelize.query(
    `INSERT INTO store_web_vitals (workspace_id, metric, value, route_kind, device_class)
     SELECT $workspaceId, m, v, $route, $device FROM unnest($names::varchar[], $values::float8[]) AS t(m, v)`,
    {
      bind: { workspaceId, route, device, names: kept.map((m) => m.name), values: kept.map((m) => m.value) },
      type: db.Sequelize.QueryTypes.INSERT,
    }
  );
}

const router = express.Router({ mergeParams: true });

router.post(
  '/',
  (req, res, next) => (env.webVitals.enabled ? next() : res.status(404).end()),
  webVitalsLimiter,
  validate(schema),
  (req, res) => {
    res.status(204).end();
    save(req.params.workspaceId, req.body).catch((err) => {
      logger.warn('[web-vitals] could not save', { message: err.message });
    });
  }
);

module.exports = router;
module.exports.vitalsBodyParser = vitalsBodyParser;
module.exports.save = save;
