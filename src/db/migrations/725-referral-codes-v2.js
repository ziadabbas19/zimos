'use strict';

const { guarded } = require('../migrationGuards');

/**
 * Referral codes, second version (modules/referrals, REFERRAL_CODES_V2_ENABLED).
 *
 * referral_codes
 *   agent_id            now optional: a code with no agent is a discount only
 *                       and earns nobody a commission
 *   audience            who may enter it: 'new' merchants, 'existing' ones,
 *                       or 'any'. Every code that exists today gets 'any'
 *                       (what it allowed); a new code defaults to 'new' in
 *                       the service, not here
 *   starts_at/ends_at   when it can be entered (optional, either side)
 *   max_uses/uses_count how many stores may enter it; uses_count is raised
 *                       in the same UPDATE that checks it (no race), and is
 *                       backfilled here from the subscriptions using it
 *   allowed_plan_ids / allowed_cycles / min_price_amount+currency
 *                       optional restrictions, checked when it is entered
 *   terms               the per-cycle discount and commission schedules
 *                       (referrals/referralTerms.js). NULL = a code of the
 *                       first kind: its discount_* on every charge and its
 *                       commission_rate_bp (or the default) on every
 *                       payment, as before. Every code that exists today
 *                       stays NULL here
 *   commission_basis    'paid' (what the merchant paid, as before) or 'list'
 *                       (the price before the code's discount)
 *   links_agent         entering it links the store to its agent when the
 *                       store has no agent yet
 *   grant_type/value    a one-time benefit given when it is entered:
 *                       trial_days, wallet_credit (minor units of the wallet
 *                       currency) or free_orders (pay per order)
 *
 * referral_code_redemptions   one row per store that entered a code. Backfilled
 *   from every subscription that carries a code today (source 'legacy').
 *   Unique per code and store always; per code and account, and per code and
 *   normalized email, for the rows written with the flag on (single_use). One
 *   row per store is its first code (is_first), and one is current (ended_at
 *   NULL). terms/commission_basis/grant_* are the code's as they stood when
 *   it was entered; NULL terms (every legacy row) = the code as it stands now.
 *
 * agent_links   which agent earns on a store's payments, from when to when:
 *   from a code (source 'code', backfilled for every legacy row whose code has
 *   an agent: legacy = TRUE, the old rule) or set by hand in the console
 *   (source 'manual'). One open link per store.
 *
 * agent_commissions   + agent_link_id, payment_no, commission_basis,
 *   base_amount; code_id becomes optional (a manual link has no code).
 * billing_invoices    + referral_redemption_id, referral_payment_no (which
 *   use of the code the charge was, counted per store and code). Backfilled
 *   for the invoices that carry a code today.
 *
 * Run-twice safe (every step guarded; every backfill is a no-op the second
 * time). down refuses while data exists that the code before this
 * migration cannot handle (a code with no agent, a commission with no code),
 * and otherwise removes everything added here.
 */

const list = (values) => values.map((v) => `'${v}'`).join(', ');

/** The same rule as referrals/emailKey.js, kept here so the migration never changes with the app. */
function emailKey(email) {
  const raw = String(email || '').trim().toLowerCase();
  const at = raw.lastIndexOf('@');
  if (at <= 0) return raw || null;
  let local = raw.slice(0, at);
  let domain = raw.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const qi = guarded(queryInterface);
    const { DataTypes } = Sequelize;
    const q = (sql, replacements) => queryInterface.sequelize.query(sql, { replacements });
    const timestamps = {
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    };
    const user = (onDelete) => ({ type: DataTypes.UUID, allowNull: true, references: { model: 'users', key: 'id' }, onDelete, onUpdate: 'CASCADE' });

    // --- referral_codes ------------------------------------------------------
    await q('ALTER TABLE referral_codes ALTER COLUMN agent_id DROP NOT NULL');
    await qi.addColumn('referral_codes', 'audience', { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'any' });
    await qi.addColumn('referral_codes', 'starts_at', { type: DataTypes.DATE, allowNull: true });
    await qi.addColumn('referral_codes', 'ends_at', { type: DataTypes.DATE, allowNull: true });
    await qi.addColumn('referral_codes', 'max_uses', { type: DataTypes.INTEGER, allowNull: true });
    await qi.addColumn('referral_codes', 'uses_count', { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
    await qi.addColumn('referral_codes', 'allowed_plan_ids', { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: true });
    await qi.addColumn('referral_codes', 'allowed_cycles', { type: DataTypes.ARRAY(DataTypes.STRING(10)), allowNull: true });
    await qi.addColumn('referral_codes', 'min_price_amount', { type: DataTypes.BIGINT, allowNull: true });
    await qi.addColumn('referral_codes', 'min_price_currency', { type: DataTypes.STRING(3), allowNull: true });
    await qi.addColumn('referral_codes', 'terms', { type: DataTypes.JSONB, allowNull: true });
    await qi.addColumn('referral_codes', 'commission_basis', { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'paid' });
    await qi.addColumn('referral_codes', 'links_agent', { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true });
    await qi.addColumn('referral_codes', 'grant_type', { type: DataTypes.STRING(20), allowNull: true });
    await qi.addColumn('referral_codes', 'grant_value', { type: DataTypes.BIGINT, allowNull: true });
    await qi.addColumn('referral_codes', 'updated_by_user_id', user('SET NULL'));
    await q('ALTER TABLE referral_codes DROP CONSTRAINT IF EXISTS referral_codes_v2_check');
    await q(
      `ALTER TABLE referral_codes ADD CONSTRAINT referral_codes_v2_check CHECK (
         audience IN ('new', 'existing', 'any')
         AND commission_basis IN ('paid', 'list')
         AND (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
         AND (max_uses IS NULL OR max_uses >= 1)
         AND uses_count >= 0
         AND ((min_price_amount IS NULL) = (min_price_currency IS NULL))
         AND (min_price_amount IS NULL OR min_price_amount >= 0)
         AND (grant_type IS NULL OR grant_type IN ('trial_days', 'wallet_credit', 'free_orders'))
         AND ((grant_type IS NULL) = (grant_value IS NULL))
         AND (grant_value IS NULL OR grant_value >= 1)
       )`
    );

    // --- referral_code_redemptions -------------------------------------------
    await qi.createTable('referral_code_redemptions', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()'), allowNull: false },
      code_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'referral_codes', key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      subscription_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'subscriptions', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      owner_user_id: user('SET NULL'),
      actor_user_id: user('SET NULL'),
      email_key: { type: DataTypes.STRING(320), allowNull: true },
      agent_id: user('SET NULL'),
      source: { type: DataTypes.STRING(20), allowNull: false },
      merchant_kind: { type: DataTypes.STRING(10), allowNull: true },
      is_first: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      single_use: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      billing_cycle: { type: DataTypes.STRING(10), allowNull: true },
      terms: { type: DataTypes.JSONB, allowNull: true },
      commission_basis: { type: DataTypes.STRING(10), allowNull: true },
      grant_type: { type: DataTypes.STRING(20), allowNull: true },
      grant_value: { type: DataTypes.BIGINT, allowNull: true },
      grant_applied_at: { type: DataTypes.DATE, allowNull: true },
      first_invoice_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'billing_invoices', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE' },
      ended_at: { type: DataTypes.DATE, allowNull: true },
      end_reason: { type: DataTypes.STRING(20), allowNull: true },
      ...timestamps,
    });
    await q('ALTER TABLE referral_code_redemptions DROP CONSTRAINT IF EXISTS referral_code_redemptions_check');
    await q(
      `ALTER TABLE referral_code_redemptions ADD CONSTRAINT referral_code_redemptions_check CHECK (
         source IN ('signup', 'plan_page', 'plan_switch', 'legacy')
         AND (merchant_kind IS NULL OR merchant_kind IN ('new', 'existing'))
         AND (billing_cycle IS NULL OR billing_cycle IN ('monthly', 'yearly'))
         AND (commission_basis IS NULL OR commission_basis IN ('paid', 'list'))
         AND (grant_type IS NULL OR grant_type IN ('trial_days', 'wallet_credit', 'free_orders'))
         AND ((ended_at IS NULL) = (end_reason IS NULL))
         AND (end_reason IS NULL OR end_reason IN ('replaced', 'detached'))
       )`
    );
    await qi.addIndex('referral_code_redemptions', ['code_id', 'workspace_id'], { name: 'referral_code_redemptions_code_ws_uniq', unique: true });
    await qi.addIndex('referral_code_redemptions', ['code_id', 'owner_user_id'], {
      name: 'referral_code_redemptions_code_owner_uniq',
      unique: true,
      where: { single_use: true, owner_user_id: { [Sequelize.Op.ne]: null } },
    });
    await qi.addIndex('referral_code_redemptions', ['code_id', 'email_key'], {
      name: 'referral_code_redemptions_code_email_uniq',
      unique: true,
      where: { single_use: true, email_key: { [Sequelize.Op.ne]: null } },
    });
    await qi.addIndex('referral_code_redemptions', ['workspace_id'], { name: 'referral_code_redemptions_first_uniq', unique: true, where: { is_first: true } });
    await qi.addIndex('referral_code_redemptions', ['subscription_id'], { name: 'referral_code_redemptions_current_uniq', unique: true, where: { ended_at: null } });
    await qi.addIndex('referral_code_redemptions', ['owner_user_id'], { name: 'referral_code_redemptions_owner_idx' });
    await qi.addIndex('referral_code_redemptions', ['code_id', 'created_at'], { name: 'referral_code_redemptions_code_created_idx' });

    // --- agent_links ---------------------------------------------------------
    await qi.createTable('agent_links', {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()'), allowNull: false },
      workspace_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'workspaces', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'CASCADE' },
      agent_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'users', key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
      source: { type: DataTypes.STRING(10), allowNull: false },
      code_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'referral_codes', key: 'id' }, onDelete: 'RESTRICT', onUpdate: 'CASCADE' },
      redemption_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'referral_code_redemptions', key: 'id' }, onDelete: 'SET NULL', onUpdate: 'CASCADE' },
      legacy: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      starts_at: { type: DataTypes.DATE, allowNull: false },
      ends_at: { type: DataTypes.DATE, allowNull: true },
      ended_at: { type: DataTypes.DATE, allowNull: true },
      end_reason: { type: DataTypes.STRING(20), allowNull: true },
      terms: { type: DataTypes.JSONB, allowNull: true },
      commission_basis: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'paid' },
      note: { type: DataTypes.TEXT, allowNull: true },
      created_by_user_id: user('SET NULL'),
      ended_by_user_id: user('SET NULL'),
      ...timestamps,
    });
    await q('ALTER TABLE agent_links DROP CONSTRAINT IF EXISTS agent_links_check');
    await q(
      `ALTER TABLE agent_links ADD CONSTRAINT agent_links_check CHECK (
         source IN ('manual', 'code')
         AND (source = 'manual' OR code_id IS NOT NULL)
         AND commission_basis IN ('paid', 'list')
         AND (ends_at IS NULL OR ends_at > starts_at)
         AND ((ended_at IS NULL) = (end_reason IS NULL))
         AND (end_reason IS NULL OR end_reason IN ('replaced', 'ended'))
         AND (legacy = FALSE OR terms IS NULL)
       )`
    );
    await qi.addIndex('agent_links', ['workspace_id'], { name: 'agent_links_open_uniq', unique: true, where: { ended_at: null } });
    await qi.addIndex('agent_links', ['agent_id'], { name: 'agent_links_agent_idx' });

    // --- agent_commissions ---------------------------------------------------
    await q('ALTER TABLE agent_commissions ALTER COLUMN code_id DROP NOT NULL');
    await qi.addColumn('agent_commissions', 'agent_link_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'agent_links', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });
    await qi.addColumn('agent_commissions', 'payment_no', { type: DataTypes.INTEGER, allowNull: true });
    await qi.addColumn('agent_commissions', 'commission_basis', { type: DataTypes.STRING(10), allowNull: true });
    await qi.addColumn('agent_commissions', 'base_amount', { type: DataTypes.BIGINT, allowNull: true });
    await qi.addIndex('agent_commissions', ['agent_link_id'], { name: 'agent_commissions_link_idx' });

    // --- billing_invoices ----------------------------------------------------
    await qi.addColumn('billing_invoices', 'referral_redemption_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'referral_code_redemptions', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });
    await qi.addColumn('billing_invoices', 'referral_payment_no', { type: DataTypes.INTEGER, allowNull: true });
    // A payment's number counts the paid charges of one use; built CONCURRENTLY by the guard (outside a transaction).
    await qi.addIndex('billing_invoices', ['referral_redemption_id'], {
      name: 'billing_invoices_referral_redemption_idx',
      where: { referral_redemption_id: { [Sequelize.Op.ne]: null } },
    });

    // --- backfill: what exists today, as the first kind ----------------------
    // Every statement is a no-op the second time (ON CONFLICT, IS NULL, GREATEST).
    await q(
      `UPDATE referral_codes c SET uses_count = GREATEST(c.uses_count, n.used)
         FROM (SELECT referral_code_id AS id, COUNT(*)::int AS used FROM subscriptions WHERE referral_code_id IS NOT NULL GROUP BY referral_code_id) n
        WHERE c.id = n.id`
    );
    // Each subscription carrying a code today: its store's first code, the
    // owner's normalized email, the code's agent as a link of the old kind.
    {
      const [rows] = await q(
        `SELECT s.id AS subscription_id, s.workspace_id, s.referral_code_id AS code_id, s.referral_code_attached_at AS attached_at,
                s.billing_cycle, w.owner_user_id, u.email, c.agent_id
           FROM subscriptions s
           JOIN workspaces w ON w.id = s.workspace_id
           JOIN referral_codes c ON c.id = s.referral_code_id
           LEFT JOIN users u ON u.id = w.owner_user_id
          WHERE s.referral_code_id IS NOT NULL`
      );
      for (const r of rows) {
        await q(
          `INSERT INTO referral_code_redemptions
             (code_id, workspace_id, subscription_id, owner_user_id, email_key, agent_id, source, is_first, single_use, billing_cycle, created_at, updated_at)
           VALUES (:codeId, :workspaceId, :subscriptionId, :ownerUserId, :emailKey, :agentId, 'legacy', TRUE, FALSE, :cycle, :at, :at)
           ON CONFLICT DO NOTHING`,
          {
            codeId: r.code_id,
            workspaceId: r.workspace_id,
            subscriptionId: r.subscription_id,
            ownerUserId: r.owner_user_id,
            emailKey: r.email ? emailKey(r.email) : null,
            agentId: r.agent_id,
            cycle: ['monthly', 'yearly'].includes(r.billing_cycle) ? r.billing_cycle : null,
            at: r.attached_at,
          }
        );
      }
      await q(
        `INSERT INTO agent_links (workspace_id, agent_id, source, code_id, redemption_id, legacy, starts_at, commission_basis, created_at, updated_at)
         SELECT r.workspace_id, r.agent_id, 'code', r.code_id, r.id, TRUE, r.created_at, 'paid', r.created_at, r.created_at
           FROM referral_code_redemptions r
          WHERE r.source = 'legacy' AND r.agent_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM agent_links l WHERE l.redemption_id = r.id)
         ON CONFLICT DO NOTHING`
      );
    }
    await q(
      `UPDATE billing_invoices i SET referral_redemption_id = r.id
         FROM referral_code_redemptions r
        WHERE i.referral_redemption_id IS NULL AND r.subscription_id = i.subscription_id AND r.code_id = i.referral_code_id`
    );
    await q(
      `UPDATE agent_commissions a SET agent_link_id = l.id, commission_basis = 'paid', base_amount = a.amount_paid
         FROM agent_links l
        WHERE a.agent_link_id IS NULL AND l.workspace_id = a.workspace_id AND l.code_id = a.code_id AND l.legacy = TRUE`
    );
    await q(`ALTER TABLE agent_commissions DROP CONSTRAINT IF EXISTS agent_commissions_basis_check`);
    await q(`ALTER TABLE agent_commissions ADD CONSTRAINT agent_commissions_basis_check CHECK (commission_basis IS NULL OR commission_basis IN (${list(['paid', 'list'])}))`);
  },

  down: async (queryInterface) => {
    const qi = guarded(queryInterface);
    const q = (sql) => queryInterface.sequelize.query(sql);
    const [[{ present }]] = await q(
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'referral_codes' AND column_name = 'audience') AS present"
    );
    if (!present) return;
    // The code before this migration charges every code's agent a commission
    // and expects every commission to have a code: rows it cannot read stop
    // the rollback here instead of breaking a payment later.
    const [[{ agentless }]] = await q('SELECT COUNT(*)::int AS agentless FROM referral_codes WHERE agent_id IS NULL');
    const [[{ codeless }]] = await q('SELECT COUNT(*)::int AS codeless FROM agent_commissions WHERE code_id IS NULL');
    if (agentless > 0 || codeless > 0) {
      throw new Error(
        `725-referral-codes-v2 down refused: ${agentless} referral code(s) have no agent and ${codeless} commission row(s) have no code. ` +
          'Give those codes an agent (or delete the unused ones) and remove the manual-link commission rows first.'
      );
    }

    await q('ALTER TABLE agent_commissions DROP CONSTRAINT IF EXISTS agent_commissions_basis_check');
    await qi.removeIndex('agent_commissions', 'agent_commissions_link_idx');
    for (const column of ['base_amount', 'commission_basis', 'payment_no', 'agent_link_id']) await qi.removeColumn('agent_commissions', column);
    await q('ALTER TABLE agent_commissions ALTER COLUMN code_id SET NOT NULL');

    await qi.removeIndex('billing_invoices', 'billing_invoices_referral_redemption_idx');
    for (const column of ['referral_payment_no', 'referral_redemption_id']) await qi.removeColumn('billing_invoices', column);

    await qi.dropTable('agent_links');
    await qi.dropTable('referral_code_redemptions');

    await q('ALTER TABLE referral_codes DROP CONSTRAINT IF EXISTS referral_codes_v2_check');
    for (const column of [
      'updated_by_user_id',
      'grant_value',
      'grant_type',
      'links_agent',
      'commission_basis',
      'terms',
      'min_price_currency',
      'min_price_amount',
      'allowed_cycles',
      'allowed_plan_ids',
      'uses_count',
      'max_uses',
      'ends_at',
      'starts_at',
      'audience',
    ]) {
      await qi.removeColumn('referral_codes', column);
    }
    await q('ALTER TABLE referral_codes ALTER COLUMN agent_id SET NOT NULL');
  },
};
