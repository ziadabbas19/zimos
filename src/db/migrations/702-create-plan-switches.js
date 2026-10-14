'use strict';

/**
 * A merchant changing plan by themselves (billing/planSwitchService,
 * PLAN_SWITCH_ENABLED). A new table only: no existing table or column
 * changes, so nothing reads it until a switch is made.
 *
 * plan_switches
 *   one row per switch a merchant asked for, from which plan and cycle to
 *   which, and what became of it:
 *     kind    upgrade    the difference for the days left, one pending charge
 *                        (billing_invoice_id); the plan changes when it is paid
 *             move       from a free plan: a full period of the new plan, from
 *                        its payment
 *             scheduled  a downgrade (or a cycle change, or another currency):
 *                        takes effect at effective_at, the end of the paid
 *                        period, applied by the hourly billing job
 *             immediate  changed at once with nothing to pay (the period had
 *                        ended, the same price)
 *     status  pending | scheduled (open: at most one per subscription, a
 *             unique partial index) | applied | cancelled | replaced |
 *             expired | dropped (no longer fitted the store at its moment;
 *             end_reason says why)
 *   `quote` keeps what the upgrade was priced on (days left, the two prices,
 *   the amount). The charge itself is an ordinary billing_invoices row with
 *   target_plan_id set; this row is what tells it apart from a pay-per-order
 *   move.
 *
 * Written to be harmless if it runs again. Down: the charge of a switch
 * still waiting is voided first (cancelled), so nobody pays it as a
 * pay-per-order move once the table is gone; a scheduled downgrade is lost
 * (the store renews on the plan it is on).
 */

const KINDS = ['upgrade', 'move', 'scheduled', 'immediate'];
const STATUSES = ['pending', 'scheduled', 'applied', 'cancelled', 'replaced', 'expired', 'dropped'];
const list = (values) => values.map((v) => `'${v}'`).join(', ');

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await run(`
        CREATE TABLE IF NOT EXISTS plan_switches (
          id UUID PRIMARY KEY,
          workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE ON UPDATE CASCADE,
          subscription_id UUID NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE ON UPDATE CASCADE,
          kind VARCHAR(12) NOT NULL CONSTRAINT plan_switches_kind_check CHECK (kind IN (${list(KINDS)})),
          status VARCHAR(12) NOT NULL CONSTRAINT plan_switches_status_check CHECK (status IN (${list(STATUSES)})),
          from_plan_id UUID REFERENCES plans (id) ON DELETE SET NULL ON UPDATE CASCADE,
          from_billing_cycle VARCHAR(10) NOT NULL CONSTRAINT plan_switches_from_cycle_check CHECK (from_billing_cycle IN ('monthly', 'yearly')),
          to_plan_id UUID REFERENCES plans (id) ON DELETE SET NULL ON UPDATE CASCADE,
          to_billing_cycle VARCHAR(10) NOT NULL CONSTRAINT plan_switches_to_cycle_check CHECK (to_billing_cycle IN ('monthly', 'yearly')),
          billing_invoice_id UUID REFERENCES billing_invoices (id) ON DELETE SET NULL ON UPDATE CASCADE,
          effective_at TIMESTAMPTZ,
          applied_at TIMESTAMPTZ,
          ended_at TIMESTAMPTZ,
          end_reason VARCHAR(40),
          quote JSONB,
          requested_by_user_id UUID,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT plan_switches_pending_charge_check CHECK (status <> 'pending' OR billing_invoice_id IS NOT NULL),
          CONSTRAINT plan_switches_scheduled_at_check CHECK (status <> 'scheduled' OR effective_at IS NOT NULL)
        )`);
      await run(
        "CREATE UNIQUE INDEX IF NOT EXISTS plan_switches_one_open_idx ON plan_switches (subscription_id) WHERE status IN ('pending', 'scheduled')"
      );
      await run('CREATE UNIQUE INDEX IF NOT EXISTS plan_switches_invoice_idx ON plan_switches (billing_invoice_id) WHERE billing_invoice_id IS NOT NULL');
      await run("CREATE INDEX IF NOT EXISTS plan_switches_due_idx ON plan_switches (effective_at) WHERE status = 'scheduled'");
      await run("CREATE INDEX IF NOT EXISTS plan_switches_waiting_idx ON plan_switches (created_at) WHERE status = 'pending'");
      await run('CREATE INDEX IF NOT EXISTS plan_switches_workspace_idx ON plan_switches (workspace_id, created_at)');
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      const [[{ exists }]] = await queryInterface.sequelize.query("SELECT to_regclass('public.plan_switches') IS NOT NULL AS exists", { transaction });
      if (exists) {
        await run(
          `UPDATE billing_invoices
              SET status = 'void', voided_at = NOW(), void_reason = 'cancelled', updated_at = NOW()
            WHERE status = 'pending'
              AND id IN (SELECT billing_invoice_id FROM plan_switches WHERE status = 'pending' AND billing_invoice_id IS NOT NULL)`
        );
      }
      await run('DROP TABLE IF EXISTS plan_switches');
    });
  },
};
