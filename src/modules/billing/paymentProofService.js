'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { AppError, ConflictError, NotFoundError } = require('../../core/errors/AppError');
const { normalizePhone } = require('../../core/utils/phone');
const { recordAudit } = require('../audit/auditService');
const { getStorage } = require('../media/storage');
const { processCustomerImage } = require('../media/imageProcessing');
const { ACCEPTED_IMAGE_TYPES } = require('../customerUploads/customerUploadService');
const charges = require('./subscriptionChargeService');
const paymentMethods = require('./paymentMethodService');
const { serializeInvoice } = require('./merchantPlansService');
const wallet = require('./walletService');
const { signedProofImageUrl } = require('./proofLinks');

/**
 * A merchant's proof of a manual transfer (InstaPay, a mobile wallet) and a
 * platform admin's review of it (payment_proofs, migration 130).
 *
 *   open     POST /workspaces/:id/billing/invoices/open (billing.manage):
 *            what paying now comes to, writing nothing — the pending charge
 *            if one is open, otherwise the next one priced as createCharge
 *            would write it, under the id NEXT_CHARGE.
 *   send     POST /workspaces/:id/billing/invoices/:invoiceId/payment-proofs
 *            (billing.manage), `:invoiceId` a pending charge of the store or
 *            NEXT_CHARGE — the charge is then written (or the pending one
 *            taken) in the proof's own transaction, so only a sent proof
 *            holds a charge open. The method (an enabled manual one), the
 *            sender's Egyptian mobile number and the screenshot (JPEG, PNG
 *            or WebP by its bytes, at most PROOF_MAX_BYTES, re-encoded
 *            without its metadata and stored privately). The amount is the
 *            server's: the charge's amount payable now, frozen with its
 *            discount and code — the merchant never sends one; an
 *            `expectedAmount` (the amount the merchant was shown) is only
 *            compared with it. One image is never accepted twice (its
 *            SHA-256 is unique), one proof waits per charge, and at most
 *            MAX_OPEN_PER_WORKSPACE per store.
 *   top-up   POST /workspaces/:id/billing/wallet/topups (WALLET_ENABLED):
 *            the same checks, for an amount the merchant chooses between
 *            walletService.MIN_TOPUP_AMOUNT and MAX_TOPUP_AMOUNT, at most
 *            walletService.MAX_OPEN_TOPUPS waiting.
 *   review   the console (payments.record): the image through a signed
 *            five-minute link. Approving takes the amount that arrived; for
 *            a charge it must be exactly the amount asked, and the charge is
 *            settled through settlePaid — the path every payment takes — at
 *            the frozen price. Anything else is not settled: the proof is
 *            rejected with a note. A top-up credits what arrived, whatever was
 *            asked, through walletService.creditTopup (topup:<proofId>).
 *            Approving twice changes nothing.
 */

const PROOF_MAX_BYTES = 8 * 1024 * 1024;
const MAX_OPEN_PER_WORKSPACE = 3;
// The charge a proof writes as it is sent: `/invoices/next/payment-proofs`.
const NEXT_CHARGE = 'next';
// An Egyptian mobile number after normalizePhone: 20, then 10, 11, 12 or 15, then 8 digits.
const EGYPT_MOBILE = /^201[0125]\d{8}$/;

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function maskPhone(phone) {
  const local = String(phone).startsWith('20') ? `0${String(phone).slice(2)}` : String(phone);
  return `${local.slice(0, 3)}*****${local.slice(-3)}`;
}

function isUniqueClash(err, name) {
  return Boolean(err && err.name === 'SequelizeUniqueConstraintError' && err.parent && err.parent.constraint === name);
}

const duplicateImage = () =>
  new ConflictError('This screenshot was already sent. Send the screenshot of this transfer.', 'PROOF_IMAGE_DUPLICATE');
const alreadyOpen = () =>
  new ConflictError('A proof for this charge is already waiting for review.', 'PROOF_ALREADY_OPEN');
const notPending = () => new ConflictError('This charge is not waiting for payment.', 'CHARGE_NOT_PENDING');
const currencyUnsupported = () =>
  new ConflictError(
    `A transfer can only pay a charge in ${paymentMethods.MANUAL_CURRENCY}. Contact support to pay this one.`,
    'MANUAL_PAYMENT_CURRENCY_UNSUPPORTED'
  );

// ------------------------------------------------------------ serialize

function serializeForMerchant(proof, method = proof.method) {
  return {
    id: proof.id,
    purpose: proof.purpose,
    invoiceId: proof.billingInvoiceId,
    method: method ? { code: method.code, label: { ar: method.labelAr, en: method.labelEn } } : { code: proof.methodCode, label: null },
    senderPhone: proof.senderPhone,
    amount: Number(proof.requestedAmount),
    currency: proof.currency,
    status: proof.status,
    // Only a rejection's note is the merchant's to read.
    reviewNote: proof.status === 'rejected' ? proof.reviewNote : null,
    createdAt: proof.createdAt,
    reviewedAt: proof.reviewedAt,
  };
}

// ------------------------------------------------------------- merchant

/**
 * POST /workspaces/:id/billing/invoices/open — the charge to pay now, and the
 * ways to pay it, writing nothing: the one already open (`written`), as it
 * comes to if paid now, or the next period's priced as createCharge would
 * write it, with the id NEXT_CHARGE and no `createdAt`. A proof sent for
 * NEXT_CHARGE writes it; the online Pay button writes its own. Nothing is
 * held open, so the plan can still change. `created` is always false (kept
 * for clients from when opening wrote the charge). Only while some way to
 * pay is offered, so a store is never shown a charge it has no way to settle.
 */
async function openInvoice(workspaceId) {
  const subscription = await db.Subscription.findOne({ where: { workspaceId }, include: [{ model: db.Plan, as: 'plan' }] });
  if (!subscription) throw new NotFoundError('Subscription');
  const currency = subscription.plan ? subscription.plan.currency : null;
  if (!(await paymentMethods.anyOffered(currency))) {
    throw new ConflictError('There is no way to pay online or by transfer right now. Contact support.', 'NO_PAYMENT_METHOD');
  }
  const { pending, quote } = await charges.quoteCharge(workspaceId);
  const { methods } = await paymentMethods.listForWorkspace(workspaceId);
  if (pending) {
    const payable = await charges.payableNow(pending);
    return {
      invoice: { ...serializeInvoice(pending), discountAmount: payable.discountAmount, amountDue: payable.amount },
      created: false,
      written: true,
      methods,
    };
  }
  return {
    invoice: {
      id: NEXT_CHARGE,
      status: 'pending',
      periodStart: quote.periodStart,
      periodEnd: quote.periodEnd,
      grossAmount: quote.grossAmount,
      discountAmount: quote.discountAmount,
      amountDue: quote.amount,
      amountPaid: null,
      currency: quote.currency,
      paidAt: null,
      paymentSource: null,
      createdAt: null,
    },
    created: false,
    written: false,
    methods,
  };
}

/** Checks the method, the number and the file; resolves what is needed to store it. */
async function readSubmission({ methodCode, senderPhone, file }) {
  const method = await paymentMethods.offeredManual(methodCode);
  if (!method) {
    throw new AppError('PAYMENT_METHOD_NOT_AVAILABLE', 'Choose one of the payment methods offered.', 422, [
      { field: 'methodCode', message: 'not offered' },
    ]);
  }
  const phone = normalizePhone(senderPhone);
  if (!phone || !EGYPT_MOBILE.test(phone)) {
    throw new AppError('INVALID_SENDER_PHONE', 'Enter the Egyptian mobile number the money was sent from.', 422, [
      { field: 'senderPhone', message: 'must be an Egyptian mobile number' },
    ]);
  }
  if (!file || !file.buffer || file.buffer.length === 0) {
    throw new AppError('NO_FILE', 'Attach the screenshot of the transfer (field name "file").', 422);
  }
  if (!ACCEPTED_IMAGE_TYPES.some((type) => type.match(file.buffer))) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'The screenshot must be a JPEG, PNG or WebP image.', 415);
  }
  const imageSha256 = sha256(file.buffer);
  if (await db.PaymentProof.count({ where: { imageSha256 } })) throw duplicateImage();
  return { method, phone, imageSha256 };
}

/**
 * Stores the screenshot (re-encoded without its metadata) and runs `write`
 * with its details; the stored object is removed again if `write` fails.
 */
async function withStoredImage(workspaceId, file, write) {
  const processed = await processCustomerImage(file.buffer);
  const key = `payment-proofs/${workspaceId}/${crypto.randomUUID()}.${processed.ext}`;
  await getStorage().putPrivate({ key, buffer: processed.buffer, contentType: processed.mime });
  try {
    return await write({ imageKey: key, imageMime: processed.mime, imageBytes: processed.buffer.length });
  } catch (err) {
    await getStorage()
      .removePrivate(key)
      .catch(() => {});
    throw err;
  }
}

/** Inside a transaction: the store's waiting proofs, counted with its subscription row locked. */
async function assertRoomForAnother(workspaceId, transaction) {
  await db.Subscription.findOne({ where: { workspaceId }, attributes: ['id'], transaction, lock: transaction.LOCK.UPDATE });
  const open = await db.PaymentProof.count({ where: { workspaceId, status: 'pending' }, transaction });
  if (open >= MAX_OPEN_PER_WORKSPACE) {
    throw new ConflictError(
      `At most ${MAX_OPEN_PER_WORKSPACE} proofs can wait for review at a time. Wait for one to be reviewed.`,
      'TOO_MANY_OPEN_PROOFS'
    );
  }
}

async function createRow(fields, transaction) {
  try {
    return await db.PaymentProof.create(fields, { transaction });
  } catch (err) {
    if (isUniqueClash(err, 'payment_proofs_image_sha256_key')) throw duplicateImage();
    if (isUniqueClash(err, 'payment_proofs_one_pending_per_invoice_idx')) throw alreadyOpen();
    throw err;
  }
}

/**
 * Before the screenshot is stored: what can be refused without a lock. A
 * charge by its id must be this store's (another store's, or one that
 * doesn't exist, is a 404 alike) and pending; NEXT_CHARGE must have a charge
 * to write (409 NO_PLAN / PLAN_IS_FREE). Either way, in MANUAL_CURRENCY.
 */
async function assertTransferCanPay(workspaceId, invoiceId) {
  let currency;
  if (invoiceId === NEXT_CHARGE) {
    const { pending, quote } = await charges.quoteCharge(workspaceId);
    currency = (pending || quote).currency;
  } else {
    const invoice = await db.BillingInvoice.findOne({ where: { id: invoiceId, workspaceId } });
    if (!invoice) throw new NotFoundError('Charge');
    if (invoice.status !== 'pending') throw notPending();
    currency = invoice.currency;
  }
  if (currency !== paymentMethods.MANUAL_CURRENCY) throw currencyUnsupported();
}

/**
 * POST /workspaces/:id/billing/invoices/:invoiceId/payment-proofs, for a
 * pending charge of the store or for NEXT_CHARGE. With NEXT_CHARGE the
 * charge is written here, in the proof's transaction (createCharge's rules:
 * the pending one if there is one, otherwise the next period at the plan's
 * price now), so a proof refused leaves no charge behind. The subscription
 * row is locked first, so two proofs sent at once write one charge and the
 * second finds its proof waiting (409 PROOF_ALREADY_OPEN). With
 * `expectedAmount`, a charge that comes to anything else is refused (409
 * CHARGE_AMOUNT_CHANGED) before anything is written.
 */
async function submitForInvoice(workspaceId, invoiceId, { methodCode, senderPhone, file, expectedAmount }, req) {
  await assertTransferCanPay(workspaceId, invoiceId);
  const { method, phone, imageSha256 } = await readSubmission({ methodCode, senderPhone, file });

  const proof = await withStoredImage(workspaceId, file, (image) =>
    db.sequelize.transaction(async (transaction) => {
      await assertRoomForAnother(workspaceId, transaction);
      const target =
        invoiceId === NEXT_CHARGE
          ? (await charges.createChargeInTransaction(workspaceId, { req, byMerchant: true }, transaction)).invoice.id
          : invoiceId;
      const locked = await db.BillingInvoice.findOne({
        where: { id: target, workspaceId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!locked) throw new NotFoundError('Charge');
      if (locked.status !== 'pending') throw notPending();
      // A charge written just now is priced in the plan's currency as it is now.
      if (locked.currency !== paymentMethods.MANUAL_CURRENCY) throw currencyUnsupported();
      if (await db.PaymentProof.count({ where: { billingInvoiceId: locked.id, status: 'pending' }, transaction })) throw alreadyOpen();

      const payable = await charges.payableNow(locked, transaction);
      if (!(payable.amount > 0)) throw new ConflictError('Nothing is due on this charge.', 'NOTHING_TO_PAY');
      if (expectedAmount != null && expectedAmount !== payable.amount) {
        throw new AppError(
          'CHARGE_AMOUNT_CHANGED',
          'The amount due has changed since the payment window opened. Check the new amount before sending.',
          409,
          { amountDue: payable.amount, currency: locked.currency }
        );
      }
      const row = await createRow(
        {
          workspaceId,
          purpose: 'invoice',
          billingInvoiceId: locked.id,
          paymentMethodId: method.id,
          methodCode: method.code,
          receivingNumber: method.accountNumber,
          senderPhone: phone,
          currency: locked.currency,
          requestedAmount: payable.amount,
          grossAmount: payable.grossAmount,
          discountAmount: payable.discountAmount,
          referralCodeId: payable.referralCodeId,
          submittedByUserId: req.user.id,
          imageSha256,
          ...image,
        },
        transaction
      );
      await recordAudit({
        workspaceId,
        actorUserId: req.user.id,
        action: 'payment_proof.submit',
        entityType: 'PaymentProof',
        entityId: row.id,
        after: { status: row.status, amount: payable.amount, currency: locked.currency },
        metadata: { billingInvoiceId: locked.id, method: method.code, senderPhone: maskPhone(phone) },
        req,
        transaction,
      });
      return row;
    })
  );
  return serializeForMerchant(proof, method);
}

/**
 * POST /workspaces/:id/billing/wallet/topups — a transfer to top up the
 * prepaid balance. The amount is the merchant's request, in minor units,
 * checked against the named limits; what is credited is what the console
 * sees arrive.
 */
async function submitTopup(workspaceId, { requestedAmount, methodCode, senderPhone, file }, req) {
  if (!wallet.enabled()) throw wallet.disabledError();
  const amount = Number(requestedAmount);
  if (!Number.isSafeInteger(amount) || amount < wallet.MIN_TOPUP_AMOUNT || amount > wallet.MAX_TOPUP_AMOUNT) {
    throw new AppError(
      'TOPUP_AMOUNT_OUT_OF_RANGE',
      'A top-up is between the minimum and the maximum the balance allows.',
      422,
      { min: wallet.MIN_TOPUP_AMOUNT, max: wallet.MAX_TOPUP_AMOUNT, currency: wallet.WALLET_CURRENCY }
    );
  }
  const { method, phone, imageSha256 } = await readSubmission({ methodCode, senderPhone, file });

  const proof = await withStoredImage(workspaceId, file, (image) =>
    db.sequelize.transaction(async (transaction) => {
      await assertRoomForAnother(workspaceId, transaction);
      const openTopups = await db.PaymentProof.count({ where: { workspaceId, purpose: 'topup', status: 'pending' }, transaction });
      if (openTopups >= wallet.MAX_OPEN_TOPUPS) {
        throw new ConflictError(
          `At most ${wallet.MAX_OPEN_TOPUPS} top-ups can wait for review at a time. Wait for one to be reviewed.`,
          'TOO_MANY_OPEN_TOPUPS'
        );
      }
      const row = await createRow(
        {
          workspaceId,
          purpose: 'topup',
          billingInvoiceId: null,
          paymentMethodId: method.id,
          methodCode: method.code,
          receivingNumber: method.accountNumber,
          senderPhone: phone,
          currency: wallet.WALLET_CURRENCY,
          requestedAmount: amount,
          submittedByUserId: req.user.id,
          imageSha256,
          ...image,
        },
        transaction
      );
      await recordAudit({
        workspaceId,
        actorUserId: req.user.id,
        action: 'payment_proof.submit',
        entityType: 'PaymentProof',
        entityId: row.id,
        after: { status: row.status, amount, currency: wallet.WALLET_CURRENCY },
        metadata: { purpose: 'topup', method: method.code, senderPhone: maskPhone(phone) },
        req,
        transaction,
      });
      return row;
    })
  );
  return serializeForMerchant(proof, method);
}

/** GET /workspaces/:id/billing/payment-proofs — the store's latest proofs, newest first. */
async function listForWorkspace(workspaceId, { limit = 20 } = {}) {
  const rows = await db.PaymentProof.findAll({
    where: { workspaceId },
    include: [{ model: db.PaymentMethod, as: 'method' }],
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: Math.min(Math.max(1, limit), 50),
  });
  // Not .map(serializeForMerchant): map's index would be taken for the method.
  return { proofs: rows.map((row) => serializeForMerchant(row)) };
}

// -------------------------------------------------------------- console

const ADMIN_INCLUDE = [
  { model: db.Workspace, as: 'workspace', attributes: ['id', 'name', 'slug'] },
  { model: db.PaymentMethod, as: 'method' },
  { model: db.User, as: 'reviewedBy', attributes: ['id', 'fullName'] },
  { model: db.User, as: 'submittedBy', attributes: ['id', 'fullName', 'email'] },
];

function serializeForAdmin(proof) {
  return {
    id: proof.id,
    purpose: proof.purpose,
    workspace: proof.workspace ? { id: proof.workspace.id, name: proof.workspace.name, slug: proof.workspace.slug } : { id: proof.workspaceId },
    invoiceId: proof.billingInvoiceId,
    method: {
      code: proof.methodCode,
      labelAr: proof.method ? proof.method.labelAr : null,
      labelEn: proof.method ? proof.method.labelEn : null,
    },
    receivingNumber: proof.receivingNumber,
    senderPhone: proof.senderPhone,
    requestedAmount: Number(proof.requestedAmount),
    receivedAmount: proof.receivedAmount == null ? null : Number(proof.receivedAmount),
    currency: proof.currency,
    status: proof.status,
    reviewNote: proof.reviewNote,
    reviewedBy: proof.reviewedBy ? { id: proof.reviewedBy.id, fullName: proof.reviewedBy.fullName } : null,
    reviewedAt: proof.reviewedAt,
    submittedBy: proof.submittedBy ? { id: proof.submittedBy.id, fullName: proof.submittedBy.fullName, email: proof.submittedBy.email } : null,
    createdAt: proof.createdAt,
  };
}

/** GET /admin/payment-proofs?status=&page=&pageSize= — waiting ones oldest first, the rest newest first. */
async function listQueue({ status = 'pending', page = 1, pageSize = 20 } = {}) {
  const size = Math.min(Math.max(1, pageSize), 50);
  const where = status === 'all' ? {} : { status };
  const { rows, count } = await db.PaymentProof.findAndCountAll({
    where,
    include: ADMIN_INCLUDE,
    order: [
      ['createdAt', status === 'pending' ? 'ASC' : 'DESC'],
      ['id', 'ASC'],
    ],
    limit: size,
    offset: (Math.max(1, page) - 1) * size,
    distinct: true,
  });
  return { proofs: rows.map(serializeForAdmin), page: Math.max(1, page), pageSize: size, total: count };
}

/**
 * GET /admin/payment-proofs/:id — the proof, its charge as it stands, what
 * would stop an approval, and the image through a signed five-minute link.
 */
async function getForReview(proofId) {
  const proof = await db.PaymentProof.findByPk(proofId, { include: ADMIN_INCLUDE });
  if (!proof) throw new NotFoundError('Payment proof');
  const invoice = proof.billingInvoiceId ? await db.BillingInvoice.findByPk(proof.billingInvoiceId) : null;
  const balance = proof.purpose === 'topup' ? await db.WorkspaceWallet.findOne({ where: { workspaceId: proof.workspaceId } }) : null;
  const image = signedProofImageUrl(proof.id);
  const blockers = [];
  if (invoice && proof.status === 'pending') {
    if (invoice.status === 'paid') blockers.push('CHARGE_ALREADY_PAID');
    if (Number(invoice.grossAmount) !== Number(proof.grossAmount)) blockers.push('CHARGE_REPRICED');
  }
  return {
    proof: serializeForAdmin(proof),
    invoice: invoice
      ? {
          id: invoice.id,
          status: invoice.status,
          amountDue: Number(invoice.amount),
          currency: invoice.currency,
          periodStart: invoice.periodStart,
          periodEnd: invoice.periodEnd,
          paidAt: invoice.paidAt,
        }
      : null,
    // A top-up: the store's balance now.
    wallet: proof.purpose === 'topup' ? { balance: balance ? Number(balance.cashBalance) : 0, currency: wallet.WALLET_CURRENCY } : null,
    // Why approving would be refused now; empty when it can go through.
    approvalBlockers: blockers,
    image: { url: image.url, expiresAt: image.expiresAt, mime: proof.imageMime },
  };
}

/** The proof's image bytes for the signed link (null when it is gone). */
async function readImage(proofId) {
  const proof = await db.PaymentProof.findByPk(proofId, { attributes: ['id', 'imageKey', 'imageMime'] });
  if (!proof) return null;
  const stored = await getStorage().getPrivate(proof.imageKey);
  return stored ? { buffer: stored.buffer, mime: proof.imageMime } : null;
}

/**
 * POST /admin/payment-proofs/:id/approve { receivedAmount }. Locks the
 * charge, then the proof (the order every payment path takes). A charge is
 * settled only when the amount received is exactly the amount asked, the
 * charge is still unpaid and hasn't been re-priced since; otherwise the
 * proof stays waiting and the reviewer rejects it with a note. A proof
 * already approved is answered as it is (`alreadyApproved`): nothing again.
 */
async function approve(proofId, { receivedAmount }, req) {
  const result = await db.sequelize.transaction(async (transaction) => {
    const head = await db.PaymentProof.findByPk(proofId, { attributes: ['id', 'billingInvoiceId'], transaction });
    if (!head) throw new NotFoundError('Payment proof');
    const invoice = head.billingInvoiceId
      ? await db.BillingInvoice.findByPk(head.billingInvoiceId, { transaction, lock: transaction.LOCK.UPDATE })
      : null;
    const proof = await db.PaymentProof.findByPk(proofId, { transaction, lock: transaction.LOCK.UPDATE });
    if (proof.status === 'approved') return { proof, alreadyApproved: true };
    if (proof.status === 'rejected') throw new ConflictError('This proof was rejected.', 'PROOF_ALREADY_REVIEWED');

    const requested = Number(proof.requestedAmount);
    if (proof.purpose === 'topup') {
      // The balance grows by what arrived, whatever was asked; the console
      // showed the two side by side before this.
      if (!(receivedAmount > 0)) {
        throw new AppError('RECEIVED_AMOUNT_REQUIRED', 'Enter the amount that arrived. If nothing arrived, reject the proof with a note.', 422);
      }
      const entry = await wallet.creditTopup(proof, receivedAmount, req.user.id, transaction);
      await proof.update({ status: 'approved', receivedAmount, reviewedByUserId: req.user.id, reviewedAt: new Date() }, { transaction });
      await recordAudit({
        actorUserId: req.user.id,
        action: 'payment_proof.approve',
        entityType: 'PaymentProof',
        entityId: proof.id,
        before: { status: 'pending' },
        after: { status: 'approved', receivedAmount },
        metadata: {
          workspaceId: proof.workspaceId,
          purpose: 'topup',
          requestedAmount: requested,
          currency: proof.currency,
          receivedDiffers: receivedAmount !== requested,
          ledgerEntryId: entry ? entry.id : null,
        },
        req,
        transaction,
      });
      return { proof, alreadyApproved: false };
    }

    if (receivedAmount !== requested) {
      throw new AppError(
        'RECEIVED_AMOUNT_MISMATCH',
        'A charge is settled only by exactly its amount. Reject this proof with a note instead.',
        422,
        { requestedAmount: requested, receivedAmount, currency: proof.currency }
      );
    }
    if (invoice.status === 'paid') {
      throw new ConflictError(
        'This charge is already paid. Reject this proof with a note; if the money arrived, refund it by hand.',
        'CHARGE_ALREADY_PAID'
      );
    }
    if (Number(invoice.grossAmount) !== Number(proof.grossAmount)) {
      throw new ConflictError('The charge was re-priced after this proof was sent. Reject it with a note.', 'CHARGE_REPRICED');
    }

    // An online checkout still open for the charge can no longer pay it.
    const [onlinePaymentsSuperseded] = await db.BillingPaymentAttempt.update(
      { status: 'superseded' },
      { where: { billingInvoiceId: invoice.id, status: db.BillingPaymentAttempt.IN_PROGRESS }, transaction }
    );
    const { commission, codeLapsed } = await charges.settlePaid(
      invoice,
      {
        paidAt: new Date(),
        amountPaid: receivedAmount,
        externalReference: `proof:${proof.id}`,
        note: `Transfer (${proof.methodCode}) checked from proof ${proof.id}`,
        recordedByUserId: req.user.id,
        source: 'manual',
        frozen: { discountAmount: proof.discountAmount, amount: proof.requestedAmount, referralCodeId: proof.referralCodeId },
      },
      transaction
    );
    await proof.update({ status: 'approved', receivedAmount, reviewedByUserId: req.user.id, reviewedAt: new Date() }, { transaction });
    await recordAudit({
      actorUserId: req.user.id,
      action: 'payment_proof.approve',
      entityType: 'PaymentProof',
      entityId: proof.id,
      before: { status: 'pending' },
      after: { status: 'approved', receivedAmount },
      metadata: {
        workspaceId: proof.workspaceId,
        billingInvoiceId: invoice.id,
        requestedAmount: requested,
        currency: proof.currency,
        commissionId: commission ? commission.id : null,
        referralCodeLapsed: codeLapsed,
        onlinePaymentsSuperseded,
      },
      req,
      transaction,
    });
    return { proof, alreadyApproved: false };
  });
  if (!result.alreadyApproved) logger.info(`payment proof ${proofId} approved: charge settled`);
  return { ...(await getForReview(proofId)), alreadyApproved: result.alreadyApproved };
}

/**
 * POST /admin/payment-proofs/:id/reject { note } — the note is required and
 * shown to the merchant. A plan switch's charge nothing else is paying is
 * then voided (planSwitchService.paymentFailed, PLAN_SWITCH_ENABLED).
 */
async function reject(proofId, { note }, req) {
  let invoiceId = null;
  const alreadyRejected = await db.sequelize.transaction(async (transaction) => {
    const proof = await db.PaymentProof.findByPk(proofId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!proof) throw new NotFoundError('Payment proof');
    if (proof.status === 'approved') throw new ConflictError('This proof was approved: the charge is paid.', 'PROOF_ALREADY_REVIEWED');
    if (proof.status === 'rejected') return true;
    await proof.update({ status: 'rejected', reviewNote: note, reviewedByUserId: req.user.id, reviewedAt: new Date() }, { transaction });
    invoiceId = proof.billingInvoiceId || null;
    await recordAudit({
      actorUserId: req.user.id,
      action: 'payment_proof.reject',
      entityType: 'PaymentProof',
      entityId: proof.id,
      before: { status: 'pending' },
      after: { status: 'rejected', reviewNote: note },
      metadata: { workspaceId: proof.workspaceId, billingInvoiceId: proof.billingInvoiceId },
      req,
      transaction,
    });
    return false;
  });
  if (invoiceId) {
    try {
      // eslint-disable-next-line global-require
      await require('./planSwitchService').paymentFailed(invoiceId, { source: 'proof_rejected' });
    } catch (err) {
      logger.warn(`payment proof ${proofId} rejected: the plan switch's charge could not be voided: ${err.message}`);
    }
  }
  return { ...(await getForReview(proofId)), alreadyRejected };
}

module.exports = {
  PROOF_MAX_BYTES,
  MAX_OPEN_PER_WORKSPACE,
  EGYPT_MOBILE,
  NEXT_CHARGE,
  openInvoice,
  submitForInvoice,
  submitTopup,
  listForWorkspace,
  listQueue,
  getForReview,
  readImage,
  approve,
  reject,
};
