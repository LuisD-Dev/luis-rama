import express from 'express';
import validate from '../middleware/validate.js';
import * as paymentSchemas from '../schemas/payment.schema.js';
import { createOrReusePayment } from '../services/paymentService.js';
import { checkout, createPaymentIntent, confirmPaymentIntent } from '../controllers/paymentsController.js';
import { verifyToken, adminOnly } from '../middleware/auth.js';
import prisma from '../utils/prismaClient.js';
import { evaluate, collectSignals, persistDecision, getMode, hashIp, getClientIp, httpStatusForDecision } from '../services/riskEngine.js';

const router = express.Router();

async function riskGuard(req, { planTier, paymentMethodId, path }) {
  const ip = getClientIp(req);
  const ipHash = hashIp(ip);
  const userId = req.user?.id;
  const mode = getMode();
  const signalsRaw = await collectSignals({ userId, ipHash, paymentMethodId, planTier, prismaClient: prisma });
  const result = evaluate(signalsRaw);
  // Persist decision for every attempt (even replay) - snapshot signals
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
  } catch (e) { next(e); }
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

      // Idempotent replay detection: if payment already exists, still record risk decision but skip double Stripe charge
      const existing = await prisma.payment.findUnique({ where: { idempotencyKey: effectiveIdempotencyKey } });
      const guard = await riskGuard(req, { planTier, paymentMethodId, path: '/api/payments/payment-method' });
      if (guard.mode === 'enforce' && guard.result.decision !== 'allow') {
        const status = httpStatusForDecision(guard.result.decision);
        const code = guard.result.decision === 'block' ? 'RISK_BLOCK' : 'RISK_CHALLENGE';
        console.warn({ ipHash: guard.ipHash, userId, decision: guard.result.decision, mode: guard.mode }, 'Risk guard blocked /payment-method');
        // Even for replay, enforce block/challenge
        return res.status(status).json({
          error: guard.result.decision === 'block' ? 'risk_block' : 'risk_challenge',
          code,
          decision: guard.result.decision,
          reasons: guard.result.reasons,
          message: guard.result.decision === 'challenge' ? 'Re-auth required: please log in again or wait and retry.' : 'Payment blocked by risk policy.',
        });
      }

      if (existing) {
        // Still update ipHash if missing for audit
        if (!existing.ipHash) {
          await prisma.payment.update({ where: { id: existing.id }, data: { ipHash: guard.ipHash } }).catch(()=>{});
        }
        return res.json({ paymentId: existing.id, stripePaymentIntentId: existing.stripePaymentIntentId, status: existing.status, replay: true });
      }

      const payment = await createOrReusePayment({
        userId,
        paymentMethodId,
        planTier,
        idempotencyKey: effectiveIdempotencyKey,
        ipHash: guard.ipHash,
      });

      // Ensure ipHash stored
      if (payment && !payment.ipHash) {
        await prisma.payment.update({ where: { id: payment.id }, data: { ipHash: guard.ipHash } }).catch(()=>{});
      }

      res.json({ paymentId: payment.id, stripePaymentIntentId: payment.stripePaymentIntentId, status: payment.status });
    } catch (err) {
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
    } catch(e){ next(e); }
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
