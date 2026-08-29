import express from 'express';
import { verifyToken } from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import * as paymentSchemas from '../schemas/payment.schema.js';
import { submitPaymentMethod, getPaymentStatus } from '../controllers/paymentController.js';
import { paymentLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

// All payment routes require auth + rate limiting
router.post('/payment-method', paymentLimiter, verifyToken, validate(paymentSchemas.submitPaymentMethod), submitPaymentMethod);
router.get('/:id', paymentLimiter, verifyToken, getPaymentStatus);
import validate from '../middleware/validate.js';
import * as paymentSchemas from '../schemas/payment.schema.js';
import {
  createOrReusePayment,
  PaymentServiceError,
} from '../services/paymentService.js';
import { PaymentTransitionError } from '../services/paymentStateMachine.js';
import { checkout, createPaymentIntent, confirmPaymentIntent } from '../controllers/paymentsController.js';
import { verifyToken, adminOnly } from '../middleware/auth.js';
import prisma from '../utils/prismaClient.js';
import { evaluate, collectSignals, persistDecision, getMode, hashIp, getClientIp, httpStatusForDecision, withRiskLock } from '../services/riskEngine.js';
import { createPaymentIntent as createPaymentIntentService } from '../services/paymentService.js';

const router = express.Router();

async function riskGuard(req, { planTier, paymentMethodId, path }) {
  const ip = getClientIp(req);
  const ipHash = hashIp(ip);
  const userId = req.user?.id;
  const mode = getMode();
  let signalsRaw;
  try {
    signalsRaw = await collectSignals({ userId, ipHash, paymentMethodId, planTier, prismaClient: prisma });
  } catch (e) {
    console.error('[riskGuard] collectSignals failed', { ipHash, userId, mode, error: e?.message });
    if (mode === 'enforce') {
      // fail-closed: do not allow payment when DB is unavailable
      throw Object.assign(new Error('risk_db_error'), { statusCode: 503, code: 'RISK_DB_ERROR', ipHash, mode });
    }
    // shadow: allow with logged error
    signalsRaw = { attemptsUserHour: 0, distinctPMsUserDay: 0, failsIpHour: 0, accountAgeMinutes: null, planTier, isWhitelisted: false, _dbError: true };
  }
  const result = evaluate(signalsRaw);
  try {
    await persistDecision({
      userId,
      ipHash,
      path: path || req.path,
      signals: result.signals,
      score: result.score,
      decision: result.decision,
      mode,
      prismaClient: prisma,
    });
  } catch (e) {
    console.error('[riskGuard] persistDecision failed', { ipHash, userId, mode, error: e?.message });
    if (mode === 'enforce') {
      throw Object.assign(new Error('risk_persist_error'), { statusCode: 503, code: 'RISK_DB_ERROR', ipHash, mode });
    }
  }
  return { ipHash, mode, result, signalsRaw };
}

router.post('/intent', verifyToken, async (req, res, next) => {
  try {
    const planTier = req.body?.plan_tier || req.body?.planTier;
    const guard = await riskGuard(req, { planTier, paymentMethodId: null, path: '/api/payments/intent' });
    if (guard.mode === 'enforce' && guard.result.decision !== 'allow') {
      const status = httpStatusForDecision(guard.result.decision);
      const code = guard.result.decision === 'block' ? 'RISK_BLOCK' : 'RISK_CHALLENGE';
      console.warn({ ipHash: guard.ipHash, userId: req.user.id, decision: guard.result.decision, mode: guard.mode, reasons: guard.result.reasons }, 'Risk guard blocked /intent');
      return res.status(status).json({
        error: guard.result.decision === 'block' ? 'risk_block' : 'risk_challenge',
        code,
        decision: guard.result.decision,
        reasons: guard.result.reasons,
        message: guard.result.decision === 'challenge' ? 'Re-auth required: please log in again or wait and retry.' : 'Payment blocked by risk policy. Contact support.',
      });
    }
    // Attach ipHash for payment creation
    req._riskIpHash = guard.ipHash;
    return createPaymentIntent(req, res);
  } catch (e) {
    if (e?.code === 'RISK_DB_ERROR') {
      console.error('[risk] DB error fail-closed /intent', e.message);
      return res.status(503).json({ error: 'risk_unavailable', code: 'RISK_DB_ERROR', message: 'Risk checks temporarily unavailable. Try again.' });
    }
    next(e);
  }
});
router.post('/intent/:id/confirm', verifyToken, adminOnly, confirmPaymentIntent);

router.post(
  '/payment-method',
  verifyToken,
  validate(paymentSchemas.createPaymentMethod),
  async (req, res, next) => {
    try {
      const userId = req.user.id;
      const { paymentMethodId, planTier, idempotencyKey } = req.body;
      const headerKey = req.headers['idempotency-key'];
      const effectiveIdempotencyKey = headerKey || idempotencyKey;
      if (!effectiveIdempotencyKey) {
        return res.status(400).json({ error: 'idempotencyKey header or body field is required' });
      }

      // Concurrency: serialize per user+IP to prevent race on counters (single-instance). For multi-instance, use Redis/distributed lock.
      const ipForLock = hashIp(getClientIp(req));
      const lockKey = `${userId}:${ipForLock}`;
      const outcome = await withRiskLock(lockKey, async () => {
        const guard = await riskGuard(req, { planTier, paymentMethodId, path: '/api/payments/payment-method' });
        if (guard.mode === 'enforce' && guard.result.decision !== 'allow') {
          return { blocked: true, guard };
        }
        const payment = await createOrReusePayment({
          userId,
          paymentMethodId,
          planTier,
          idempotencyKey: effectiveIdempotencyKey,
          ipHash: guard.ipHash,
        });
        if (payment && !payment.ipHash) {
          await prisma.payment.update({ where: { id: payment.id }, data: { ipHash: guard.ipHash } }).catch(()=>{});
        }
        return { payment };
      });

      if (outcome.blocked) {
        const { guard } = outcome;
        const status = httpStatusForDecision(guard.result.decision);
        const code = guard.result.decision === 'block' ? 'RISK_BLOCK' : 'RISK_CHALLENGE';
        return res.status(status).json({
          error: guard.result.decision === 'block' ? 'risk_block' : 'risk_challenge',
          code,
          decision: guard.result.decision,
          reasons: guard.result.reasons,
          message: guard.result.decision === 'challenge'
            ? 'Re-auth required: please log in again or wait and retry.'
            : 'Payment blocked by risk policy.',
        });
      }

      const { payment } = outcome;
      return res.json({
        paymentId: payment.id,
        stripePaymentIntentId: payment.stripePaymentIntentId,
        status: payment.status,
        planTier: payment.planTier,
      });
    } catch (err) {
      if (
        err instanceof PaymentServiceError ||
        err instanceof PaymentTransitionError
      ) {
        const statusCode =
          Number.isInteger(err.statusCode) &&
          err.statusCode >= 400 &&
          err.statusCode <= 599
            ? err.statusCode
            : 500;
        const body = {
          error: err.clientMessage || err.message || 'Payment request failed',
          ...(err.code ? { code: err.code } : {}),
        };
        return res.status(statusCode).json(body);
      }
      next(err);
    }
  }
);

router.post(
  '/checkout',
  verifyToken,
  validate(paymentSchemas.createCheckout),
  async (req, res, next) => {
    try {
      const guard = await riskGuard(req, { planTier: req.body?.plan, paymentMethodId: null, path: '/api/payments/checkout' });
      if (guard.mode === 'enforce' && guard.result.decision !== 'allow') {
        const status = httpStatusForDecision(guard.result.decision);
        const code = guard.result.decision === 'block' ? 'RISK_BLOCK' : 'RISK_CHALLENGE';
        return res.status(status).json({
          error: guard.result.decision === 'block' ? 'risk_block' : 'risk_challenge',
          code,
          decision: guard.result.decision,
          reasons: guard.result.reasons,
          message: guard.result.decision === 'challenge' ? 'Re-auth required.' : 'Payment blocked by risk policy.',
        });
      }
      req._riskIpHash = guard.ipHash;
      return checkout(req, res, next);
    } catch(e){
      if (e?.code === 'RISK_DB_ERROR') {
        console.error('[risk] DB error fail-closed /checkout', e.message);
        return res.status(503).json({ error: 'risk_unavailable', code: 'RISK_DB_ERROR', message: 'Risk checks temporarily unavailable. Try again.' });
      }
      next(e);
    }
  }
);

export default router;
