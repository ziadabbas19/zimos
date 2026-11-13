'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { NotFoundError } = require('../../core/errors/AppError');
const audience = require('./campaignAudience');
const consent = require('./consent');
const signupSettings = require('./signupSettings');

/**
 * The footer and popup signups (public), and what the merchant's Signup
 * placement section reads: the settings, how many addresses campaigns can
 * reach, and where their consent came from.
 */

/**
 * POST /store/:id/email-signup { email, source: footer | popup }. The answer is
 * the same whether the address was known, new, already subscribed or caught
 * by the honeypot: it tells nobody who is on the list. A place switched off
 * (or the plan without campaigns) is 404.
 */
async function subscribe(workspace, body) {
  const place = signupSettings.PLACE_OF[body.source];
  if (!place || !(await signupSettings.placeOpen(workspace, place))) throw new NotFoundError('Email signup');
  // A bot's submission is answered like a real one and stored nowhere.
  if (body.website) return { ok: true };
  await consent.grant({ workspaceId: workspace.id, email: body.email, source: body.source });
  return { ok: true };
}

/** Everyone a campaign to "everyone subscribed" would reach now, by where they signed up ('other': before sources were kept, or elsewhere). */
async function stats(workspaceId) {
  const { sql, replacements } = await audience.build(workspaceId, { type: 'all' });
  const rows = await db.sequelize.query(`SELECT COALESCE(a.source, 'other') AS source, count(*)::int AS n FROM (${sql}) a GROUP BY 1`, {
    replacements,
    type: QueryTypes.SELECT,
  });
  const bySource = Object.fromEntries([...signupSettings.SOURCES, 'other'].map((s) => [s, 0]));
  for (const row of rows) bySource[signupSettings.SOURCES.includes(row.source) ? row.source : 'other'] += row.n;
  return { subscribers: rows.reduce((sum, r) => sum + r.n, 0), bySource };
}

/** GET …/email-campaigns/signup: the settings, the numbers, and whether the order form asks for an email at all. */
async function view(workspaceId) {
  const workspace = await db.Workspace.findByPk(workspaceId, { attributes: ['id', 'settings'] });
  const { resolveCheckoutSettings } = require('../checkout/checkoutSettings');
  return {
    settings: signupSettings.read(workspace && workspace.settings),
    stats: await stats(workspaceId),
    // hidden: the checkout and quick order boxes have no address to subscribe and are not shown.
    checkoutEmailField: resolveCheckoutSettings(workspace).email,
  };
}

module.exports = { subscribe, stats, view };
