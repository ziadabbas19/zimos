'use strict';

const { QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { STATS_CTE, toSql } = require('../contacts/segmentRules');
const { SCORED } = require('../rfm');
const orderLock = require('../orders/orderLock');

/**
 * Who a campaign goes to. Only the store's own customers who agreed to
 * marketing (customers.marketing_consent, false unless they ticked a box or
 * signed up), with an email address, and never one who:
 *   - unsubscribed from a marketing email, or answered STOP on WhatsApp
 *     (marketing_opt_outs, by email or by phone),
 *   - bounced hard or marked the store's email as spam (email_suppressions),
 *   - the store blocked (blocked_entries, a blacklisted customer),
 *   - is known only from locked orders (orders/orderLock): the email carries
 *     the store's Reply-To, so an answer would hand the merchant the address.
 * Then the audience narrows it: all of them, a saved segment
 * (contacts/segmentRules.js), RFM groups (modules/rfm) or orders / spend rules.
 * One row per address (two customers sharing one email get one email).
 *
 * "Everyone subscribed" also reaches the lightweight subscribers of the
 * footer and popup signups (email_subscribers, migration 749) whose address
 * no customer of the store has: once a customer has it, the customer's own
 * consent is the one that counts. The rules, segments and RFM groups read
 * orders, so they reach customers only. Each row carries where its consent
 * came from (`source`, null when unknown), for the Signup placement numbers.
 *
 * The same SQL counts the audience before sending and lists it when sending
 * starts, so the number the merchant saw is the number queued (give or take
 * whoever opted out in between).
 */

const EMAIL_SHAPE = "'^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'";

async function build(workspaceId, audience = { type: 'all' }) {
  const replacements = { workspaceId, ws: workspaceId };
  const conditions = [
    'c.workspace_id = :workspaceId',
    'c.marketing_consent = TRUE',
    'c.is_blacklisted = FALSE',
    'c.email IS NOT NULL',
    `lower(trim(c.email)) ~ ${EMAIL_SHAPE}`,
    `NOT EXISTS (SELECT 1 FROM marketing_opt_outs mo WHERE mo.workspace_id = c.workspace_id
                   AND (mo.email = lower(trim(c.email)) OR mo.phone_normalized = c.phone_normalized))`,
    'NOT EXISTS (SELECT 1 FROM email_suppressions es WHERE es.workspace_id = c.workspace_id AND es.email = lower(trim(c.email)))',
    `NOT EXISTS (SELECT 1 FROM blocked_entries be WHERE be.workspace_id = c.workspace_id
                   AND ((be.type = 'email' AND be.value = lower(trim(c.email))) OR (be.type = 'phone' AND be.value = c.phone_normalized)))`,
  ];
  const visible = orderLock.customerVisibleSql(await orderLock.contextFor(workspaceId), 'c');
  if (visible !== 'TRUE') conditions.push(visible);

  let withStats = false;
  let withRfm = false;
  const type = audience && audience.type;
  if (type === 'segment') {
    const segment = await db.Segment.findOne({ where: { id: audience.segmentId, workspaceId }, attributes: ['id', 'rules'] });
    // A segment deleted after the campaign was saved matches nobody rather than everybody.
    if (!segment) conditions.push('FALSE');
    else {
      const { rulesSchema } = require('../contacts/segmentRules');
      const { value } = rulesSchema.validate(segment.rules || {}, { stripUnknown: true });
      const built = toSql(value, 'seg');
      conditions.push(...built.conditions);
      Object.assign(replacements, built.replacements);
      withStats = true;
    }
  } else if (type === 'rules') {
    const built = toSql(audience.rules || {}, 'aud');
    conditions.push(...built.conditions);
    Object.assign(replacements, built.replacements);
    withStats = true;
  } else if (type === 'rfm') {
    conditions.push('r.label IN (:rfmLabels)');
    replacements.rfmLabels = audience.labels && audience.labels.length ? audience.labels : ['__none__'];
    withRfm = true;
  }

  // MATERIALIZED: each is worked out once. Inlined, the planner (which expects
  // few consenting customers) can redo the whole store's order stats per
  // customer — minutes instead of milliseconds on a store with 60,000 orders.
  const stats = STATS_CTE.replace(/^\s*stats AS \(/, 'stats AS MATERIALIZED (');
  if (withStats && stats === STATS_CTE) throw new Error('campaignAudience: segmentRules.STATS_CTE changed shape');
  const ctes = [withStats ? stats : null, withRfm ? `rfm AS MATERIALIZED (${SCORED})` : null].filter(Boolean);
  const joins = [withStats ? 'LEFT JOIN stats s ON s.customer_id = c.id' : '', withRfm ? 'JOIN rfm r ON r.customer_id = c.id' : ''].join(' ');
  // One row per address: the customer seen first keeps it.
  const customers = `${ctes.length ? `WITH ${ctes.join(', ')}` : ''}
    SELECT DISTINCT ON (lower(trim(c.email))) c.id AS customer_id, lower(trim(c.email)) AS email, c.marketing_consent_source AS source
      FROM customers c ${joins}
     WHERE ${conditions.join('\n       AND ')}
     ORDER BY lower(trim(c.email)), c.created_at, c.id`;
  if (type && type !== 'all') return { sql: customers, replacements };
  // Subscribers with no customer behind the address, under the same opt-out, suppression and block rules.
  const sql = `SELECT * FROM (${customers}) cust
    UNION ALL
    SELECT NULL::uuid AS customer_id, s.email, s.source
      FROM email_subscribers s
     WHERE s.workspace_id = :workspaceId
       AND s.marketing_consent = TRUE
       AND s.email ~ ${EMAIL_SHAPE}
       AND NOT EXISTS (SELECT 1 FROM customers c2 WHERE c2.workspace_id = s.workspace_id AND c2.email IS NOT NULL AND lower(trim(c2.email)) = s.email)
       AND NOT EXISTS (SELECT 1 FROM marketing_opt_outs mo WHERE mo.workspace_id = s.workspace_id AND mo.email = s.email)
       AND NOT EXISTS (SELECT 1 FROM email_suppressions es WHERE es.workspace_id = s.workspace_id AND es.email = s.email)
       AND NOT EXISTS (SELECT 1 FROM blocked_entries be WHERE be.workspace_id = s.workspace_id AND be.type = 'email' AND be.value = s.email)`;
  return { sql, replacements };
}

/** How many addresses the audience reaches right now. */
async function count(workspaceId, audience) {
  const { sql, replacements } = await build(workspaceId, audience);
  const [row] = await db.sequelize.query(`SELECT count(*)::int AS n FROM (${sql}) a`, { replacements, type: QueryTypes.SELECT });
  return row ? row.n : 0;
}

/**
 * Inside the start-sending transaction: one queued row per address for the
 * campaign. UNIQUE (campaign_id, email) makes a second run add nothing.
 * Returns how many rows the campaign has.
 */
async function materialize(campaign, { transaction }) {
  const { sql, replacements } = await build(campaign.workspaceId, campaign.audience);
  await db.sequelize.query(
    `INSERT INTO email_campaign_recipients (id, campaign_id, workspace_id, customer_id, email, status, created_at)
     SELECT gen_random_uuid(), :campaignId, :workspaceId, a.customer_id, a.email, 'queued', NOW()
       FROM (${sql}) a
     ON CONFLICT (campaign_id, email) DO NOTHING`,
    { replacements: { ...replacements, campaignId: campaign.id }, transaction }
  );
  const [row] = await db.sequelize.query('SELECT count(*)::int AS n FROM email_campaign_recipients WHERE campaign_id = :id', {
    replacements: { id: campaign.id },
    type: QueryTypes.SELECT,
    transaction,
  });
  return row.n;
}

/**
 * Just before one email goes: may this address still be emailed? (An opt-out,
 * a suppression, a block or a withdrawn consent may have come in since the
 * campaign started.) Null when it may, otherwise why not.
 */
async function stillReachable(workspaceId, recipient, { transaction } = {}) {
  // A subscriber (no customer id) consents by their own row, unless a customer
  // with the address has come since: then that customer's consent counts.
  const [row] = await db.sequelize.query(
    `SELECT
        EXISTS (SELECT 1 FROM email_suppressions es WHERE es.workspace_id = :ws AND es.email = :email) AS suppressed,
        EXISTS (SELECT 1 FROM marketing_opt_outs mo WHERE mo.workspace_id = :ws AND (mo.email = :email
                OR mo.phone_normalized = (SELECT c.phone_normalized FROM customers c WHERE c.id = :customerId))) AS opted_out,
        EXISTS (SELECT 1 FROM blocked_entries be WHERE be.workspace_id = :ws AND be.type = 'email' AND be.value = :email) AS blocked,
        CASE WHEN CAST(:customerId AS uuid) IS NOT NULL
             THEN COALESCE((SELECT c.marketing_consent AND NOT c.is_blacklisted FROM customers c WHERE c.id = :customerId AND c.workspace_id = :ws), FALSE)
             WHEN EXISTS (SELECT 1 FROM customers c WHERE c.workspace_id = :ws AND c.email IS NOT NULL AND lower(trim(c.email)) = :email)
             THEN EXISTS (SELECT 1 FROM customers c WHERE c.workspace_id = :ws AND c.email IS NOT NULL AND lower(trim(c.email)) = :email
                           AND c.marketing_consent AND NOT c.is_blacklisted)
             ELSE COALESCE((SELECT s.marketing_consent FROM email_subscribers s WHERE s.workspace_id = :ws AND s.email = :email), FALSE)
        END AS consenting`,
    { replacements: { ws: workspaceId, email: recipient.email, customerId: recipient.customerId || null }, type: QueryTypes.SELECT, transaction }
  );
  if (row.suppressed) return 'suppressed';
  if (row.opted_out) return 'unsubscribed';
  if (row.blocked) return 'blocked';
  if (!row.consenting) return 'no_consent';
  return null;
}

module.exports = { build, count, materialize, stillReachable };
