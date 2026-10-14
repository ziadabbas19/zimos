'use strict';

/**
 * An in-memory stand-in for src/db/models, for unit tests of the billing
 * code that must run with no database (jest.mock('../../src/db/models', () =>
 * require('../helpers/fakeBillingDb').create())). Only what that code uses:
 * create, findByPk, findOne, findAll, count, update and decrement, with a
 * `where` of plain values, arrays (IN) and Op.ne / lt / lte / gt / gte / in /
 * notIn; `order` by one or more fields. A literal in Op.and is ignored.
 * Transactions run their callback at once; locks are no-ops.
 */

const crypto = require('crypto');
const { Op } = require('sequelize');

const comparable = (value) => (value instanceof Date ? value.getTime() : value);

function matches(row, where = {}) {
  for (const key of Reflect.ownKeys(where)) {
    if (typeof key === 'symbol') continue;
    const cond = where[key];
    const value = row[key];
    if (Array.isArray(cond)) {
      if (!cond.includes(value)) return false;
    } else if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      for (const op of Reflect.ownKeys(cond)) {
        const target = cond[op];
        const v = comparable(value);
        const t = comparable(target);
        if (op === Op.ne && v === t) return false;
        if (op === Op.lt && !(v < t)) return false;
        if (op === Op.lte && !(v <= t)) return false;
        if (op === Op.gt && !(v > t)) return false;
        if (op === Op.gte && !(v >= t)) return false;
        if (op === Op.in && !target.includes(value)) return false;
        if (op === Op.notIn && target.includes(value)) return false;
      }
    } else if (comparable(value) !== comparable(cond)) {
      return false;
    }
  }
  return true;
}

function sorted(rows, order) {
  if (!Array.isArray(order) || order.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const [field, direction] of order) {
      const x = comparable(a[field]);
      const y = comparable(b[field]);
      if (x === y) continue;
      const less = x < y ? -1 : 1;
      return String(direction).toUpperCase() === 'DESC' ? -less : less;
    }
    return 0;
  });
}

function makeRow(data) {
  const row = { ...data };
  const hidden = (name, value) => Object.defineProperty(row, name, { value, enumerable: false, writable: true });
  hidden('update', async (values) => {
    Object.assign(row, values, { updatedAt: new Date() });
    return row;
  });
  hidden('reload', async () => row);
  hidden('toJSON', () => ({ ...row }));
  hidden('increment', async (field, { by = 1 } = {}) => {
    row[field] = Number(row[field] || 0) + by;
    return row;
  });
  return row;
}

function model(name, defaults = {}) {
  const rows = [];
  return {
    name,
    rows,
    async create(data) {
      const now = new Date();
      const row = makeRow({ id: crypto.randomUUID(), createdAt: now, updatedAt: now, ...defaults, ...data });
      rows.push(row);
      return row;
    },
    async findByPk(id) {
      return rows.find((r) => r.id === id) || null;
    },
    async findOne({ where = {}, order } = {}) {
      return sorted(rows.filter((r) => matches(r, where)), order)[0] || null;
    },
    async findAll({ where = {}, order, limit } = {}) {
      const list = sorted(rows.filter((r) => matches(r, where)), order);
      return limit ? list.slice(0, limit) : list;
    },
    async count({ where = {} } = {}) {
      return rows.filter((r) => matches(r, where)).length;
    },
    async update(values, { where = {} } = {}) {
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, values, { updatedAt: new Date() });
      return [hit.length];
    },
    async decrement(field, { by = 1, where = {} } = {}) {
      for (const r of rows.filter((x) => matches(x, where))) r[field] = Number(r[field] || 0) - by;
      return [];
    },
  };
}

const MODELS = {
  Plan: { isActive: true, isPublic: true, perOrderFeeAmount: 0, currency: 'EGP' },
  Subscription: { pricingKind: 'paid', referralCodeId: null, graceUntil: null, trialEndsAt: null, cancelAtPeriodEnd: false },
  BillingInvoice: { status: 'pending', discountAmount: 0, referralCodeId: null, specialTermsId: null, targetPlanId: null, targetBillingCycle: null, amountPaid: null },
  PlanSwitch: {},
  BillingPaymentAttempt: {},
  PaymentProof: {},
  ReferralCode: {},
  SubscriptionTerm: {},
  WalletLedgerEntry: {},
  WorkspaceWallet: {},
  Workspace: {},
  AgentCommission: {},
  AuditLog: {},
};

function create() {
  const transaction = { LOCK: { UPDATE: 'UPDATE' }, afterCommit: (fn) => fn() };
  const db = {
    Sequelize: { Op },
    sequelize: {
      transaction: async (fn) => fn(transaction),
      literal: (sql) => ({ literal: sql }),
      col: (name) => ({ col: name }),
      query: async () => [[], 0],
    },
    transaction,
    reset() {
      for (const name of Object.keys(MODELS)) db[name].rows.length = 0;
    },
  };
  for (const [name, defaults] of Object.entries(MODELS)) db[name] = model(name, defaults);
  db.BillingPaymentAttempt.IN_PROGRESS = ['created', 'open', 'pending'];
  db.BillingPaymentAttempt.SETTLED = ['paid', 'paid_duplicate', 'mismatch'];
  db.PlanSwitch.OPEN = ['pending', 'scheduled'];
  return db;
}

module.exports = { create, matches };
