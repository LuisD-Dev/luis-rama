import crypto from 'crypto';
import prisma from '../utils/prismaClient.js';
import stripeClient from './stripeClient.js';
import { recordPaymentEvent, markPaymentCompleted, PaymentNotFoundError } from './paymentService.js';

/**
 * Stripe PaymentIntent.status -> local Payment.status mapping. Only these four
 * Stripe statuses are conclusive enough to act on; anything else (processing,
 * requires_capture, requires_confirmation, ...) is left untouched so the tool
 * never guesses at an in-flight payment. Entitlements only move on the two
 * conclusive ends of the mapping — "succeeded" grants, "canceled" revokes
 * whatever this specific PaymentIntent had granted; requires_payment_method
 * and requires_action are pure status corrections that never touch a plan.
 *
 * (Local status is spelled "completed" here, not the literal Stripe word
 * "succeeded", to match the vocabulary the rest of this codebase already uses
 * for Payment.status — see markPaymentCompleted/statsController, which key
 * revenue reporting off status "completed". Using "succeeded" as a distinct
 * value would silently split payments across two words for the same state.)
 *
 * Stripe status              -> Local Payment.status
 * succeeded                  -> completed (+ ensure planTier/subscription via markPaymentCompleted)
 * canceled                   -> canceled (+ revoke the entitlement this PaymentIntent granted,
 *                                if the local Payment had actually reached "completed" before —
 *                                do not keep paid access sourced from a PaymentIntent Stripe
 *                                now says was canceled)
 * requires_payment_method    -> pending
 * requires_action            -> pending
 */
export const STRIPE_STATUS_MAP = Object.freeze({
  succeeded: 'completed',
  canceled: 'canceled',
  requires_payment_method: 'pending',
  requires_action: 'pending',
});

const DB_CANDIDATE_STATUSES = ['pending', 'processing', 'failed'];
const DEFAULT_LIMIT = 50;

const SINCE_PATTERN = /^(\d+)(h|d|m)$/i;
const SINCE_UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse "24h" / "7d" / "30m" into a Date cutoff. Pure — no I/O. */
export function parseSince(value) {
  if (value == null) return null;
  const match = SINCE_PATTERN.exec(String(value).trim());
  if (!match) {
    throw new Error(`Invalid --since value "${value}". Use formats like 24h, 7d, 30m.`);
  }
  const amount = Number(match[1]);
  const unitMs = SINCE_UNIT_MS[match[2].toLowerCase()];
  return new Date(Date.now() - amount * unitMs);
}

/** Pure: Stripe status -> local status, or null when the state is inconclusive. */
export function mapStripeStatusToLocal(stripeStatus) {
  return STRIPE_STATUS_MAP[stripeStatus] ?? null;
}

/**
 * Pure: compare a local Payment row against the live Stripe PaymentIntent and
 * describe the divergence, if any. Never touches the database or Stripe.
 */
export function buildDiff({ payment, stripePaymentIntent }) {
  const stripeStatus = stripePaymentIntent.status;
  const mappedLocalStatus = mapStripeStatusToLocal(stripeStatus);
  const localStatus = payment.status;
  const mismatch = mappedLocalStatus !== null && mappedLocalStatus !== localStatus;

  return {
    paymentId: payment.id,
    stripePaymentIntentId: stripePaymentIntent.id,
    stripeStatus,
    localStatus,
    mappedLocalStatus,
    mismatch,
  };
}

/** Pure: fold a list of per-candidate results into the CLI summary shape. */
export function summarize(results) {
  const summary = { checked: 0, mismatched: 0, repaired: 0, skipped: 0, errors: 0 };
  for (const result of results) {
    summary.checked += 1;
    if (result.mismatch) summary.mismatched += 1;
    if (result.action === 'repaired') summary.repaired += 1;
    if (result.action === 'skipped') summary.skipped += 1;
    if (result.action === 'error') summary.errors += 1;
  }
  return summary;
}

/** Caso B: local rows stuck in a non-terminal status that still point at Stripe. */
export async function getDbCandidates({ since = null, limit = DEFAULT_LIMIT } = {}) {
  return prisma.payment.findMany({
    where: {
      stripePaymentIntentId: { not: null },
      status: { in: DB_CANDIDATE_STATUSES },
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
}

/** Single-payment lookup for --payment-id. Any status is eligible (admin-forced check). */
export async function getCandidateByPaymentId(paymentId) {
  const payment = await prisma.payment.findUnique({ where: { id: Number(paymentId) } });
  if (!payment) {
    throw new PaymentNotFoundError();
  }
  if (!payment.stripePaymentIntentId) {
    throw new Error(`Payment ${paymentId} has no stripePaymentIntentId; nothing to reconcile against Stripe.`);
  }
  return payment;
}

/**
 * Caso A: ask Stripe directly for PaymentIntents created in the window, then
 * pair each with its local row (if any). A PaymentIntent with no local Payment
 * is returned with `payment: null` — reconciliation only ever corrects rows we
 * already know about, it never fabricates a new Payment.
 */
export async function getStripeListCandidates({ since, limit }, { excludePaymentIds = new Set() } = {}) {
  const intents = await stripeClient.listPaymentIntents({ since, limit });
  if (intents.length === 0) return [];

  const payments = await prisma.payment.findMany({
    where: { stripePaymentIntentId: { in: intents.map((pi) => pi.id) } },
  });
  const byStripeId = new Map(payments.map((p) => [p.stripePaymentIntentId, p]));

  return intents
    .map((pi) => ({ payment: byStripeId.get(pi.id) || null, stripePaymentIntent: pi }))
    .filter((candidate) => !(candidate.payment && excludePaymentIds.has(candidate.payment.id)));
}

/** Merge Caso B (primary) and Caso A (fills remaining budget), capped at `limit`. */
export async function getCandidates({ since, limit = DEFAULT_LIMIT }) {
  const dbPayments = await getDbCandidates({ since, limit });
  const dbCandidates = dbPayments.map((payment) => ({ payment, stripePaymentIntent: null }));

  const remaining = limit - dbCandidates.length;
  let stripeCandidates = [];
  if (remaining > 0) {
    const excludePaymentIds = new Set(dbPayments.map((p) => p.id));
    stripeCandidates = await getStripeListCandidates({ since, limit: remaining }, { excludePaymentIds });
  }

  return [...dbCandidates, ...stripeCandidates].slice(0, limit);
}

/**
 * Revoke the entitlement this Payment previously granted. Mirrors the same
 * simplifying assumption paymentService.js's customer.subscription.deleted
 * handler already relies on elsewhere in this codebase: this app models one
 * active plan per user (a single User.planTier/role pair), so losing the
 * subscription tied to this PaymentIntent downgrades the user unconditionally
 * — it does not attempt to check for some other, unrelated active plan.
 */
async function revokeEntitlementForCanceledPayment(tx, payment) {
  const subscription = payment.stripePaymentIntentId
    ? await tx.subscription.findUnique({
        where: { provider_externalId: { provider: payment.provider, externalId: payment.stripePaymentIntentId } },
      })
    : null;

  if (subscription && subscription.status !== 'canceled') {
    await tx.subscription.update({ where: { id: subscription.id }, data: { status: 'canceled' } });
  }

  await tx.user.update({
    where: { id: payment.userId },
    data: { planTier: null, role: 'student' },
  });
}

/**
 * Apply a repair for a mismatched (payment, diff) pair.
 * - "completed": delegates entirely to markPaymentCompleted (existing, tested
 *   logic) so plan activation, subscription upsert and entitlement flags stay
 *   in exactly one place.
 * - "canceled" / "pending": a Payment.status correction, wrapped in a
 *   transaction together with its audit PaymentEvent. Only revokes the user's
 *   entitlement when the payment had actually reached "completed" before.
 */
async function applyRepair({ payment, diff, runId }) {
  if (diff.mappedLocalStatus === 'completed') {
    await markPaymentCompleted({
      paymentId: payment.id,
      subscriptionExternalId: diff.stripePaymentIntentId || payment.externalId,
      eventPayload: { source: 'reconcile', runId, stripeStatus: diff.stripeStatus },
      eventIdempotencyKey: `reconcile:${runId}:${payment.id}:completed`,
    });
    await recordPaymentEvent({
      paymentId: payment.id,
      type: 'reconcile.repaired',
      payload: { runId, from: payment.status, to: diff.mappedLocalStatus, stripeStatus: diff.stripeStatus },
      idempotencyKey: `reconcile:${runId}:${payment.id}:repaired`,
      outcome: 'processed',
    });
    return;
  }

  // A completed payment whose PaymentIntent Stripe now reports canceled had
  // actually granted access — repairing its status must also revoke that
  // access, not just relabel the row.
  const revokesEntitlement = diff.mappedLocalStatus === 'canceled' && payment.status === 'completed';

  await prisma.$transaction(async (tx) => {
    await tx.payment.update({ where: { id: payment.id }, data: { status: diff.mappedLocalStatus } });
    if (revokesEntitlement) {
      await revokeEntitlementForCanceledPayment(tx, payment);
    }
    await recordPaymentEvent({
      paymentId: payment.id,
      type: 'reconcile.repaired',
      payload: {
        runId,
        from: payment.status,
        to: diff.mappedLocalStatus,
        stripeStatus: diff.stripeStatus,
        entitlementRevoked: revokesEntitlement,
      },
      idempotencyKey: `reconcile:${runId}:${payment.id}:repaired`,
      outcome: 'processed',
      tx,
    });
  });
}

/**
 * Process one (payment, stripePaymentIntent) pair. In dry-run mode this is a
 * pure read: it computes the diff and returns it without writing anything, so
 * --dry-run can never modify the database. In apply mode it records an audit
 * trail for every candidate (reconcile.checked when nothing was wrong,
 * reconcile.mismatch + reconcile.repaired when a known-safe repair was made).
 */
async function processCandidate({ payment, stripePaymentIntent }, { runId, apply }) {
  const diff = buildDiff({ payment, stripePaymentIntent });

  if (!apply) {
    return { ...diff, action: diff.mismatch ? 'would_repair' : 'none' };
  }

  if (!diff.mismatch) {
    await recordPaymentEvent({
      paymentId: payment.id,
      type: 'reconcile.checked',
      payload: { runId, stripeStatus: diff.stripeStatus, localStatus: diff.localStatus },
      idempotencyKey: `reconcile:${runId}:${payment.id}:checked`,
      outcome: 'processed',
    });
    return { ...diff, action: 'checked' };
  }

  await recordPaymentEvent({
    paymentId: payment.id,
    type: 'reconcile.mismatch',
    payload: { runId, ...diff },
    idempotencyKey: `reconcile:${runId}:${payment.id}:mismatch`,
    outcome: 'processed',
  });

  try {
    await applyRepair({ payment, diff, runId });
    return { ...diff, action: 'repaired' };
  } catch (err) {
    await recordPaymentEvent({
      paymentId: payment.id,
      type: 'reconcile.error',
      payload: { runId, message: err.message },
      idempotencyKey: `reconcile:${runId}:${payment.id}:error`,
      outcome: 'failed',
    }).catch(() => {});
    return { ...diff, action: 'error', error: err.message };
  }
}

const orphanResult = (stripePaymentIntent) => ({
  paymentId: null,
  stripePaymentIntentId: stripePaymentIntent.id,
  stripeStatus: stripePaymentIntent.status,
  localStatus: null,
  mappedLocalStatus: mapStripeStatusToLocal(stripePaymentIntent.status),
  mismatch: false,
  action: 'skipped',
  reason: 'no_local_payment',
});

/**
 * Entry point used by the CLI. Resolves candidates (either a single
 * --payment-id or the --since/--limit window), diffs each against Stripe, and
 * — only when apply=true — repairs known-safe mismatches with a full audit
 * trail. A per-candidate error never aborts the run; it is recorded and
 * reflected in summary.errors so the caller can set a non-zero exit code.
 */
export async function reconcilePayments({
  since = null,
  limit = DEFAULT_LIMIT,
  paymentId = null,
  apply = false,
  runId = crypto.randomUUID(),
} = {}) {
  const candidates = paymentId
    ? [{ payment: await getCandidateByPaymentId(paymentId), stripePaymentIntent: null }]
    : await getCandidates({ since, limit });

  const results = [];

  for (const candidate of candidates) {
    if (!candidate.payment) {
      const result = orphanResult(candidate.stripePaymentIntent);
      if (apply) {
        await recordPaymentEvent({
          paymentId: null,
          type: 'reconcile.skipped',
          payload: {
            runId,
            reason: result.reason,
            stripePaymentIntentId: result.stripePaymentIntentId,
            stripeStatus: result.stripeStatus,
          },
          idempotencyKey: `reconcile:${runId}:orphan:${result.stripePaymentIntentId}`,
          outcome: 'ignored',
        }).catch(() => {});
      }
      results.push(result);
      continue;
    }

    try {
      const stripePaymentIntent =
        candidate.stripePaymentIntent || (await stripeClient.retrievePaymentIntent(candidate.payment.stripePaymentIntentId));
      results.push(await processCandidate({ payment: candidate.payment, stripePaymentIntent }, { runId, apply }));
    } catch (err) {
      if (apply) {
        await recordPaymentEvent({
          paymentId: candidate.payment.id,
          type: 'reconcile.error',
          payload: { runId, message: err.message, stage: 'stripe_lookup' },
          idempotencyKey: `reconcile:${runId}:${candidate.payment.id}:error`,
          outcome: 'failed',
        }).catch(() => {});
      }
      results.push({
        paymentId: candidate.payment.id,
        stripePaymentIntentId: candidate.payment.stripePaymentIntentId,
        stripeStatus: null,
        localStatus: candidate.payment.status,
        mappedLocalStatus: null,
        mismatch: false,
        action: 'error',
        error: err.message,
      });
    }
  }

  return { runId, results, summary: summarize(results) };
}

export default {
  STRIPE_STATUS_MAP,
  parseSince,
  mapStripeStatusToLocal,
  buildDiff,
  summarize,
  getDbCandidates,
  getCandidateByPaymentId,
  getStripeListCandidates,
  getCandidates,
  reconcilePayments,
};
