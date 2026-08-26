import express from 'express';
import validate from '../middleware/validate.js';
import * as paymentSchemas from '../schemas/payment.schema.js';
import { createOrReusePayment } from '../services/paymentService.js';
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
        // Idempotent replay detection: if payment already exists, still record risk decision but skip double Stripe charge
        const existing = await prisma.payment.findUnique({ where: { idempotencyKey: effectiveIdempotencyKey } });
        const guard = await riskGuard(req, { planTier, paymentMethodId, path: '/api/payments/payment-method' });
        if (guard.mode === 'enforce' && guard.result.decision !== 'allow') {
          return { blocked: true, guard, existing };
        }
        if (existing) {
          if (!existing.ipHash) {
            await prisma.payment.update({ where: { id: existing.id }, data: { ipHash: guard.ipHash } }).catch(()=>{});
          }
          return { replay: true, payment: existing, guard };
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
        return { payment, guard };
      });

      if (outcome.blocked) {
        const { guard } = outcome;
        const status = httpStatusForDecision(guard.result.decision);
        const code = guard.result.decision === 'block' ? 'RISK_BLOCK' : 'RISK_CHALLENGE';
        console.warn({ ipHash: guard.ipHash, userId, decision: guard.result.decision, mode: guard.mode }, 'Risk guard blocked /payment-method');
        return res.status(status).json({
          error: guard.result.decision === 'block' ? 'risk_block' : 'risk_challenge',
          code,
          decision: guard.result.decision,
          reasons: guard.result.reasons,
          message: guard.result.decision === 'challenge' ? 'Re-auth required: please log in again or wait and retry.' : 'Payment blocked by risk policy.',
        });
      }
      if (outcome.replay) {
        return res.json({ paymentId: outcome.payment.id, stripePaymentIntentId: outcome.payment.stripePaymentIntentId, status: outcome.payment.status, replay: true });
      }
      const { payment } = outcome;
      return res.json({ paymentId: payment.id, stripePaymentIntentId: payment.stripePaymentIntentId, status: payment.status });
    } catch (err) {
      if (err?.code === 'RISK_DB_ERROR' || err?.message?.includes('risk_blocked')) {
        const guard = err.riskResult ? { result: err.riskResult, ipHash: err.ipHash, mode: err.mode } : null;
        if (guard) {
          const status = httpStatusForDecision(guard.result.decision);
          const code = guard.result.decision === 'block' ? 'RISK_BLOCK' : 'RISK_CHALLENGE';
          return res.status(status).json({ error: guard.result.decision === 'block' ? 'risk_block' : 'risk_challenge', code, decision: guard.result.decision, reasons: guard.result.reasons });
        }
        console.error('[risk] DB error fail-closed /payment-method', err.message);
        return res.status(503).json({ error: 'risk_unavailable', code: 'RISK_DB_ERROR', message: 'Risk checks temporarily unavailable. Try again.' });
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

// Admin read API: recent blocks/challenges
router.get('/risk/decisions', verifyToken, adminOnly, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const decisionFilter = req.query.decision ? String(req.query.decision) : null;
  const where = {};
  if (decisionFilter && ['block','challenge','allow'].includes(decisionFilter)) where.decision = decisionFilter;
  // If no filter, show blocks and challenges by default
  if (!decisionFilter) where.decision = { in: ['block','challenge'] };
  const rows = await prisma.riskDecision.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  res.json({ decisions: rows.map(r => ({ ...r, signals: (()=>{ try{ return JSON.parse(r.signalsJson);}catch{return r.signalsJson;}})() })) });
});

// Whitelist endpoint
router.post('/risk/whitelist/:userId', verifyToken, adminOnly, async (req, res) => {
  const targetId = Number(req.params.userId);
  const { whitelisted } = req.body;
  const value = Boolean(whitelisted);
  const user = await prisma.user.update({ where: { id: targetId }, data: { riskWhitelisted: value } });
  res.json({ userId: user.id, riskWhitelisted: user.riskWhitelisted });
});
router.patch('/risk/whitelist/:userId', verifyToken, adminOnly, async (req, res) => {
  const targetId = Number(req.params.userId);
  const { whitelisted } = req.body;
  const value = whitelisted !== undefined ? Boolean(whitelisted) : true;
  const user = await prisma.user.update({ where: { id: targetId }, data: { riskWhitelisted: value } });
  res.json({ userId: user.id, riskWhitelisted: user.riskWhitelisted });
});

// Alternate admin path for convenience: GET /admin/risk/decisions proxy
router.get('/admin/decisions', verifyToken, adminOnly, async (req, res) => {
  const rows = await prisma.riskDecision.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  res.json({ decisions: rows });
});

export default router;
