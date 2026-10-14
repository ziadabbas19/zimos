'use strict';

const { Router } = require('express');
const validate = require('../../core/middleware/validate');
const { authenticate } = require('../../core/middleware/authenticate');
const { resolveTenant } = require('../../core/middleware/tenantContext');
const { requirePermission } = require('../../core/middleware/rbac');
const { PERMISSIONS } = require('../../core/security/permissions');
const controller = require('./billingController');
const schemas = require('./billingValidation');
const { createIpMinuteLimiter, paymentProofLimiter } = require('../../core/middleware/rateLimiters');
const payments = require('./paymentController');
const { requireConfirmedAccount } = require('../../core/middleware/confirmedAccount');
const env = require('../../config/env');

// Trying referral codes is limited per IP, so codes can't be walked.
const codePreviewLimiter = createIpMinuteLimiter('code-preview', 20, { skip: () => env.isTest });

// Mounted at /api/v1/workspaces/:workspaceId/billing. The merchant's side of
// their own subscription: billing.manage (the owner, and the accountant role).
const router = Router({ mergeParams: true });
router.use(authenticate, resolveTenant, requirePermission(PERMISSIONS.BILLING_MANAGE));

router.get('/', controller.getWorkspaceBilling);
router.patch('/', validate(schemas.setBillingCycle), controller.setBillingCycle);
router.post('/referral-code', validate(schemas.attachReferralCode), controller.attachReferralCode);
// The Subscription section: the plans with their prices, what a code would
// take off them, the charges page by page, and changing plan while nothing
// is paid (billing/merchantPlansService).
router.get('/plans', controller.listPlans);
router.post('/code-preview', codePreviewLimiter, validate(schemas.previewCode), controller.previewCode);
router.get('/invoices', validate(schemas.listInvoices), controller.listInvoices);
router.post('/plan', validate(schemas.changePlan), controller.changePlan);
router.post('/plan-move', validate(schemas.requestPlanMove), controller.requestPlanMove);
router.post('/plan-move/cancel', controller.cancelPlanMove);
// Changing plan by itself at any time (billing/planSwitchService,
// PLAN_SWITCH_ENABLED): what a switch would do, starting it, and cancelling
// the one waiting (cancelling works with the flag off too).
router.post('/plan-switch/preview', validate(schemas.previewPlanSwitch), controller.previewPlanSwitch);
router.post('/plan-switch', validate(schemas.startPlanSwitch), controller.startPlanSwitch);
router.post('/plan-switch/cancel', controller.cancelPlanSwitch);
// Paying the charge online (billing/onlineBillingService), when
// ONLINE_BILLING_ENABLED is on and the plan is priced in EGP.
router.post('/payments', validate(schemas.startOnlinePayment), controller.startOnlinePayment);
router.get('/payments/:paymentId', validate(schemas.getOnlinePayment), controller.getOnlinePayment);
// The ways to pay (billing/paymentMethodService), the charge to pay now
// (nothing written), and a manual transfer's proof, which writes the charge
// when sent for `next` (billing/paymentProofService).
router.get('/payment-methods', payments.listPaymentMethods);
router.post('/invoices/open', payments.openInvoice);
router.post(
  '/invoices/:invoiceId/payment-proofs',
  paymentProofLimiter,
  payments.acceptProofFile,
  validate(schemas.submitInvoiceProof),
  payments.submitInvoiceProof
);
router.get('/payment-proofs', payments.listPaymentProofs);
// The prepaid balance and the pay-per-order plan (billing/walletService,
// WALLET_ENABLED): the balance, its ledger, a top-up transfer's proof, and
// choosing the plan.
router.get('/wallet', payments.getWallet);
router.get('/wallet/ledger', validate(schemas.walletLedger), payments.getWalletLedger);
router.post('/wallet/topups', paymentProofLimiter, payments.acceptProofFile, validate(schemas.submitTopup), payments.submitTopup);
// A card top-up through a gateway of Zimos's own; GET /payments/:paymentId reads it back.
router.post('/wallet/topups/online', paymentProofLimiter, validate(schemas.startOnlineTopup), payments.startOnlineTopup);
// Refunds of unused balance (billing/walletRefundService).
router.get('/wallet/refunds', payments.getWalletRefunds);
router.post('/wallet/refunds', paymentProofLimiter, validate(schemas.requestWalletRefund), payments.requestWalletRefund);
router.post('/wallet/refunds/:refundId/cancel', validate(schemas.walletRefundParams), payments.cancelWalletRefund);
router.post('/pay-per-order', requireConfirmedAccount, payments.choosePayPerOrder);

module.exports = router;
