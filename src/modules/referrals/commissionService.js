'use strict';

const { Op, QueryTypes } = require('sequelize');
const db = require('../../db/models');
const { ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const { commissionRateFor, suggestedCommission } = require('./commissionPolicy');
const terms = require('./referralTerms');
const agentLinks = require('./agentLinkService');
const { v2Enabled } = require('./referralPricing');

/**
 * The agent commission ledger (agent_commissions, migration 106).
 *
 * A row is written for every billing invoice that is paid while carrying a
 * referral code — the subscription's first payment and every renewal alike —
 * by billing/subscriptionChargeService in the transaction that marks the
 * invoice paid. `isFirstPayment` tells the two apart, because whether
 * renewals earn commission is decided later, row by row, by a person.
 *
 * Tracking only. The system never pays anything and never changes
 * payoutStatus on its own; the one write to it is `markPaid`, a person with
 * commissions.mark_paid recording that they paid it, with an optional note.
 * There is no way back to pending.
 *
 * When a payment recorded by hand is reversed, its row is VOIDED (`voidForInvoice`),
 * never deleted: voided_at / voided_by_admin_id / void_reason are set and
 * payoutStatus is left alone, so a row that was already paid out stays on the
 * record as money to recover. Voided rows never count in totals and cannot be
 * marked paid. A charge paid again after a reversal gets a new live row.
 */

const PAYOUT_STATUSES = ['pending', 'marked_paid'];
// The ledger's list filter: the two payout states count live rows only.
const LIST_STATUSES = ['pending', 'marked_paid', 'voided'];

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

/**
 * What a paid invoice earns, and for whom: the store's agent link in force
 * when it was paid (agentLinkService.linkAt). Null when nothing is earned.
 *
 *   - a link of the old kind (backfilled from before migration 725, or made
 *     by a code of the first kind): earns as a code did then, on a payment
 *     that carries its code (the charge service has re-checked the code at
 *     payment: a code still on a paid invoice was active), at the code's
 *     rate now, on what was received; once the console has given that code a
 *     schedule (flag on), at the schedule's rate for this link's payment;
 *   - a link from a code of the second kind: while the code is active, on a
 *     charge written once the store had entered it (the commission starts
 *     with the payment the code was applied to), at its schedule;
 *   - a link set by hand: on every payment from its start, at its schedule.
 *
 * A schedule's rate is the one for the link's next payment number (1 + its
 * live rows); past its last finite step nothing is earned and no row is
 * written. The basis is what was received ('paid', which a payment recorded
 * by hand can set below or above the amount due) or the charge's price
 * before the code's discount ('list').
 *
 * A store with no link whose invoice carries a code with an agent (nothing
 * should be left like that after migration 725's backfill) earns as before.
 */
async function earningFor(invoice, billingCycle, transaction) {
  const received = Number(invoice.amountPaid == null ? invoice.amount : invoice.amountPaid);
  const link = await agentLinks.linkAt(invoice.workspaceId, invoice.paidAt, transaction);
  if (!link) {
    if (!invoice.referralCodeId) return null;
    const code = await db.ReferralCode.findByPk(invoice.referralCodeId, { transaction });
    if (!code || !code.agentId) return null;
    const rate = commissionRateFor(code);
    return { agentId: code.agentId, codeId: code.id, link: null, rate, basis: 'paid', base: received, paymentNo: null };
  }
  const code = link.codeId ? await db.ReferralCode.findByPk(link.codeId, { transaction }) : null;
  const paymentNo = (await db.AgentCommission.count({ where: { agentLinkId: link.id, voidedAt: null }, transaction })) + 1;
  const earning = { agentId: link.agentId, codeId: link.codeId, link, paymentNo, basis: link.commissionBasis || 'paid' };
  if (link.legacy) {
    if (invoice.referralCodeId !== link.codeId || !code) return null;
    // Its code given a schedule since (flag on): the code's commission steps now, at this link's payment number.
    if (v2Enabled() && code.terms) {
      const rate = terms.commissionRateAt(terms.forCycle(code.terms, billingCycle).commission, paymentNo);
      if (rate == null) return null;
      const basis = code.commissionBasis || 'paid';
      return { ...earning, rate, basis, base: terms.commissionOn({ basis, paid: received, list: invoice.grossAmount, rateBp: rate }).base };
    }
    return { ...earning, rate: commissionRateFor(code), basis: 'paid', base: received };
  }
  if (link.source === 'code') {
    if (!code || !code.active) return null;
    if (new Date(invoice.createdAt) < new Date(link.startsAt)) return null;
  }
  const rate = terms.commissionRateAt((link.terms && link.terms[billingCycle]) || [], paymentNo);
  if (rate == null) return null;
  const { base } = terms.commissionOn({ basis: earning.basis, paid: received, list: invoice.grossAmount, rateBp: rate });
  return { ...earning, rate, base };
}

/**
 * Writes the ledger row for a paid invoice that earns a commission
 * (earningFor). `amountPaid` keeps what was received whatever the basis.
 * Idempotent on the invoice (unique billing_invoice_id): a second call
 * returns the row the first wrote.
 */
async function recordForPaidInvoice(invoice, { isFirstPayment, billingCycle = 'monthly' }, transaction) {
  if (invoice.status !== 'paid') return null;
  const existing = await db.AgentCommission.findOne({
    where: { billingInvoiceId: invoice.id, voidedAt: null },
    transaction,
  });
  if (existing) return existing;

  const earning = await earningFor(invoice, billingCycle, transaction);
  if (!earning) return null;
  const received = Number(invoice.amountPaid == null ? invoice.amount : invoice.amountPaid);
  return db.AgentCommission.create(
    {
      agentId: earning.agentId,
      codeId: earning.codeId,
      agentLinkId: earning.link ? earning.link.id : null,
      paymentNo: earning.paymentNo,
      commissionBasis: earning.basis,
      baseAmount: earning.base,
      workspaceId: invoice.workspaceId,
      billingInvoiceId: invoice.id,
      amountPaid: received,
      currency: invoice.currency,
      paidAt: invoice.paidAt,
      commissionRateBp: earning.rate,
      suggestedCommission: suggestedCommission(Math.max(0, earning.base), earning.rate),
      isFirstPayment,
      payoutStatus: 'pending',
    },
    { transaction }
  );
}

/**
 * `forAgent` is the agent's own read-only view: who marked a row paid is
 * another platform user's identity, so it is left out.
 */
function serializeCommission(row, { forAgent = false } = {}) {
  return {
    id: row.id,
    agentId: row.agentId,
    agentName: !forAgent && row.agent ? row.agent.fullName : undefined,
    // { id: null } for a store linked by hand (migration 725): no code.
    code: row.code ? { id: row.code.id, code: row.code.code, label: row.code.label } : { id: row.codeId || null },
    agentLinkId: row.agentLinkId || null,
    // Which payment of the link it was, and what the rate was applied to.
    paymentNo: row.paymentNo == null ? null : row.paymentNo,
    commissionBasis: row.commissionBasis || 'paid',
    baseAmount: row.baseAmount == null ? Number(row.amountPaid) : Number(row.baseAmount),
    workspace: row.workspace ? { id: row.workspace.id, name: row.workspace.name } : { id: row.workspaceId },
    billingInvoiceId: row.billingInvoiceId,
    amountPaid: Number(row.amountPaid),
    currency: row.currency,
    paidAt: row.paidAt,
    commissionRateBp: row.commissionRateBp,
    suggestedCommission: Number(row.suggestedCommission),
    isFirstPayment: row.isFirstPayment,
    payoutStatus: row.payoutStatus,
    payoutNote: row.payoutNote,
    markedPaidAt: row.markedPaidAt,
    markedPaidBy:
      forAgent || !row.markedPaidBy ? null : { id: row.markedPaidBy.id, fullName: row.markedPaidBy.fullName },
    // Set when the payment behind the row was reversed.
    voidedAt: row.voidedAt,
    voidReason: row.voidReason,
    voidedBy: forAgent || !row.voidedBy ? null : { id: row.voidedBy.id, fullName: row.voidedBy.fullName },
  };
}

function whereFor({ agentId, codeId, workspaceId, status }) {
  const where = {};
  if (agentId) where.agentId = agentId;
  if (codeId) where.codeId = codeId;
  if (workspaceId) where.workspaceId = workspaceId;
  if (status === 'voided') where.voidedAt = { [Op.ne]: null };
  else if (status) Object.assign(where, { payoutStatus: status, voidedAt: null });
  return where;
}

/**
 * Pending and marked-paid totals per currency, over every LIVE row the filter
 * matches (not just the page); voided rows never count. Two currencies are
 * never added together.
 */
async function totalsFor(filter) {
  if (filter.status === 'voided') return [];
  const clauses = ['voided_at IS NULL'];
  const replacements = {};
  for (const [key, column] of [
    ['agentId', 'agent_id'],
    ['codeId', 'code_id'],
    ['workspaceId', 'workspace_id'],
    ['status', 'payout_status'],
  ]) {
    if (filter[key]) {
      clauses.push(`${column} = :${key}`);
      replacements[key] = filter[key];
    }
  }
  const rows = await db.sequelize.query(
    `SELECT currency,
            COALESCE(SUM(suggested_commission) FILTER (WHERE payout_status = 'pending'), 0) AS pending,
            COALESCE(SUM(suggested_commission) FILTER (WHERE payout_status = 'marked_paid'), 0) AS "markedPaid",
            COALESCE(SUM(amount_paid), 0) AS "amountPaid",
            COUNT(*)::int AS payments
       FROM agent_commissions
      WHERE ${clauses.join(' AND ')}
      GROUP BY currency
      ORDER BY currency`,
    { replacements, type: QueryTypes.SELECT }
  );
  return rows.map((r) => ({
    currency: r.currency,
    pending: Number(r.pending),
    markedPaid: Number(r.markedPaid),
    amountPaid: Number(r.amountPaid),
    payments: r.payments,
  }));
}

async function listCommissions(filter = {}, { forAgent = false } = {}) {
  const limit = Math.min(filter.limit || LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX);
  const offset = filter.offset || 0;
  const include = [
    { model: db.ReferralCode, as: 'code', attributes: ['id', 'code', 'label'] },
    { model: db.Workspace, as: 'workspace', attributes: ['id', 'name'] },
  ];
  if (!forAgent) {
    include.push({ model: db.User, as: 'agent', attributes: ['id', 'fullName'] });
    include.push({ model: db.User, as: 'markedPaidBy', attributes: ['id', 'fullName'] });
    include.push({ model: db.User, as: 'voidedBy', attributes: ['id', 'fullName'] });
  }
  const [{ rows, count }, totals] = await Promise.all([
    db.AgentCommission.findAndCountAll({
      where: whereFor(filter),
      include,
      order: [
        ['paidAt', 'DESC'],
        ['id', 'ASC'],
      ],
      limit,
      offset,
    }),
    totalsFor(filter),
  ]);
  return {
    commissions: rows.map((r) => serializeCommission(r, { forAgent })),
    total: count,
    limit,
    offset,
    totals,
  };
}

async function markPaid(commissionId, { note }, req) {
  return db.sequelize.transaction(async (transaction) => {
    const row = await db.AgentCommission.findByPk(commissionId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!row) throw new NotFoundError('Commission');
    if (row.voidedAt) {
      throw new ConflictError('This commission was voided when its payment was reversed.', 'COMMISSION_VOIDED');
    }
    if (row.payoutStatus === 'marked_paid') {
      throw new ConflictError('This commission is already marked paid.', 'COMMISSION_ALREADY_MARKED_PAID');
    }

    await row.update(
      {
        payoutStatus: 'marked_paid',
        payoutNote: note ? note : null,
        markedPaidByAdminId: req.user.id,
        markedPaidAt: new Date(),
      },
      { transaction }
    );
    // Platform-level, like the other admin writes: workspace_id NULL, with the
    // merchant named in the metadata instead.
    await recordAudit({
      actorUserId: req.user.id,
      action: 'agent_commission.mark_paid',
      entityType: 'AgentCommission',
      entityId: row.id,
      before: { payoutStatus: 'pending', payoutNote: null },
      after: { payoutStatus: 'marked_paid', payoutNote: row.payoutNote },
      metadata: {
        agentId: row.agentId,
        workspaceId: row.workspaceId,
        billingInvoiceId: row.billingInvoiceId,
        amountPaid: Number(row.amountPaid),
        suggestedCommission: Number(row.suggestedCommission),
        currency: row.currency,
      },
      req,
      transaction,
    });

    await row.reload({
      include: [
        { model: db.ReferralCode, as: 'code', attributes: ['id', 'code', 'label'] },
        { model: db.Workspace, as: 'workspace', attributes: ['id', 'name'] },
        { model: db.User, as: 'agent', attributes: ['id', 'fullName'] },
        { model: db.User, as: 'markedPaidBy', attributes: ['id', 'fullName'] },
      ],
      transaction,
    });
    return serializeCommission(row);
  });
}

/**
 * Voids the live ledger row of `invoiceId`, if it has one, inside the caller's
 * transaction (the payment reversal). Returns the voided row, or null. The
 * caller audits the reversal as a whole.
 */
async function voidForInvoice(invoiceId, { reason }, req, transaction) {
  const row = await db.AgentCommission.findOne({
    where: { billingInvoiceId: invoiceId, voidedAt: null },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!row) return null;
  await row.update(
    { voidedAt: new Date(), voidedByAdminId: req.user.id, voidReason: reason || 'Payment reversed' },
    { transaction }
  );
  return row;
}

module.exports = {
  earningFor,
  PAYOUT_STATUSES,
  LIST_STATUSES,
  recordForPaidInvoice,
  voidForInvoice,
  serializeCommission,
  listCommissions,
  markPaid,
  totalsFor,
};
