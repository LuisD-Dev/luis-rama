import crypto from 'crypto';
import prisma from '../utils/prismaClient.js';
import stripeClient from './stripeClient.js';
import {
  recordPaymentEvent,
  markPaymentCompleted,
  PaymentNotFoundError,
} from './paymentService.js';
import {
  PAYMENT_STATUSES,
  PaymentTransitionError,
  applyTransition,
} from './paymentStateMachine.js';

/**
 * Only Stripe statuses with an actionable canonical local meaning are mapped.
 * In-flight Stripe statuses remain observations and never cause a guessed
 * local transition.
 */
export const STRIPE_STATUS_MAP = Object.freeze({
  succeeded: PAYMENT_STATUSES.SUCCEEDED,
  canceled: PAYMENT_STATUSES.CANCELED,
  requires_payment_method: PAYMENT_STATUSES.PENDING,
  requires_action: PAYMENT_STATUSES.PENDING,
});

const DB_CANDIDATE_STATUSES = [
  PAYMENT_STATUSES.CREATED,
  PAYMENT_STATUSES.PENDING,
  PAYMENT_STATUSES.PROCESSING,
  PAYMENT_STATUSES.FAILED,
];
const LEGACY_SUCCESS_PAYMENT_STATUSES = new Set(['completed', 'processed']);
const DEFAULT_LIMIT = 50;
const MAX_CONVERGENCE_STEPS = 5;

const SYSTEM_RECONCILE_META = Object.freeze({
  retryKind: 'reconcile',
  source: 'system_reconcile',
  actorType: 'system',
  reason: 'Stripe PaymentIntent reconciliation',
});

const SINCE_PATTERN = /^(\d+)(h|d|m)$/i;
const SINCE_UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse "24h" / "7d" / "30m" into a Date cutoff. Pure; no I/O. */
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

/** Pure: Stripe status -> canonical local status, or null when inconclusive. */
export function mapStripeStatusToLocal(stripeStatus) {
  return STRIPE_STATUS_MAP[stripeStatus] ?? null;
}

/**
 * Pure: compare a local Payment row against the live Stripe PaymentIntent.
 * Legacy successful rows are rollout-compatible with canonical succeeded,
 * but reconciliation never writes either legacy value.
 */
export function buildDiff({ payment, stripePaymentIntent }) {
  const stripeStatus = stripePaymentIntent.status;
  const mappedLocalStatus = mapStripeStatusToLocal(stripeStatus);
  const localStatus = payment.status;
  const legacySuccessMatch =
    mappedLocalStatus === PAYMENT_STATUSES.SUCCEEDED &&
    LEGACY_SUCCESS_PAYMENT_STATUSES.has(localStatus);
  const mismatch =
    mappedLocalStatus !== null &&
    mappedLocalStatus !== localStatus &&
    !legacySuccessMatch;

  return {
    paymentId: payment.id,
    stripePaymentIntentId: stripePaymentIntent.id,
    stripeStatus,
    localStatus,
    mappedLocalStatus,
    mismatch,
  };
}

/** Pure: fold per-candidate results into the CLI summary shape. */
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

/**
 * Return the legal canonical edges needed to reach a Stripe reconciliation
 * target. This planner deliberately has no terminal-state escape hatch.
 */
export function planReconciliationTransitions(from, target) {
  if (from === target) return [];
  if (
    target === PAYMENT_STATUSES.SUCCEEDED &&
    LEGACY_SUCCESS_PAYMENT_STATUSES.has(from)
  ) {
    return [];
  }

  if (from === PAYMENT_STATUSES.SUCCEEDED || from === PAYMENT_STATUSES.CANCELED) {
    throw new PaymentTransitionError(from, target, {
      currentStatus: from,
      detail: 'terminal payment state conflicts with Stripe reconciliation target',
    });
  }

  const paths = {
    [PAYMENT_STATUSES.CREATED]: {
      [PAYMENT_STATUSES.PENDING]: [PAYMENT_STATUSES.PENDING],
      [PAYMENT_STATUSES.SUCCEEDED]: [
        PAYMENT_STATUSES.PENDING,
        PAYMENT_STATUSES.PROCESSING,
        PAYMENT_STATUSES.SUCCEEDED,
      ],
      [PAYMENT_STATUSES.CANCELED]: [
        PAYMENT_STATUSES.PENDING,
        PAYMENT_STATUSES.CANCELED,
      ],
    },
    [PAYMENT_STATUSES.PENDING]: {
      [PAYMENT_STATUSES.SUCCEEDED]: [
        PAYMENT_STATUSES.PROCESSING,
        PAYMENT_STATUSES.SUCCEEDED,
      ],
      [PAYMENT_STATUSES.CANCELED]: [PAYMENT_STATUSES.CANCELED],
    },
    [PAYMENT_STATUSES.PROCESSING]: {
      [PAYMENT_STATUSES.PENDING]: [
        PAYMENT_STATUSES.FAILED,
        PAYMENT_STATUSES.PENDING,
      ],
      [PAYMENT_STATUSES.SUCCEEDED]: [PAYMENT_STATUSES.SUCCEEDED],
      [PAYMENT_STATUSES.CANCELED]: [PAYMENT_STATUSES.CANCELED],
    },
    [PAYMENT_STATUSES.FAILED]: {
      [PAYMENT_STATUSES.PENDING]: [PAYMENT_STATUSES.PENDING],
      [PAYMENT_STATUSES.SUCCEEDED]: [
        PAYMENT_STATUSES.PENDING,
        PAYMENT_STATUSES.PROCESSING,
        PAYMENT_STATUSES.SUCCEEDED,
      ],
      [PAYMENT_STATUSES.CANCELED]: [
        PAYMENT_STATUSES.PENDING,
        PAYMENT_STATUSES.CANCELED,
      ],
    },
  };

  const path = paths[from]?.[target];
  if (!path) {
    throw new PaymentTransitionError(from, target, {
      currentStatus: from,
      detail: 'no legal reconciliation path exists',
    });
  }
  return [...path];
}

/** Local rows that may still need Stripe truth applied. */
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

/** Single-payment lookup for --payment-id. Any status is eligible. */
export async function getCandidateByPaymentId(paymentId) {
  const payment = await prisma.payment.findUnique({ where: { id: Number(paymentId) } });
  if (!payment) throw new PaymentNotFoundError();
  if (!payment.stripePaymentIntentId) {
    throw new Error(
      `Payment ${paymentId} has no stripePaymentIntentId; nothing to reconcile against Stripe.`
    );
  }
  return payment;
}

/**
 * Ask Stripe for PaymentIntents in the window and pair them with local rows.
 * Orphan PaymentIntents are reported but never used to fabricate a Payment.
 */
export async function getStripeListCandidates(
  { since, limit },
  { excludePaymentIds = new Set() } = {}
) {
  const intents = await stripeClient.listPaymentIntents({ since, limit });
  if (intents.length === 0) return [];

  const payments = await prisma.payment.findMany({
    where: { stripePaymentIntentId: { in: intents.map((pi) => pi.id) } },
  });
  const byStripeId = new Map(
    payments.map((payment) => [payment.stripePaymentIntentId, payment])
  );

  return intents
    .map((stripePaymentIntent) => ({
      payment: byStripeId.get(stripePaymentIntent.id) || null,
      stripePaymentIntent,
    }))
    .filter(
      (candidate) =>
        !(candidate.payment && excludePaymentIds.has(candidate.payment.id))
    );
}

/** Merge DB and Stripe candidates, capped at limit. */
export async function getCandidates({ since, limit = DEFAULT_LIMIT }) {
  const dbPayments = await getDbCandidates({ since, limit });
  const dbCandidates = dbPayments.map((payment) => ({
    payment,
    stripePaymentIntent: null,
  }));

  const remaining = limit - dbCandidates.length;
  let stripeCandidates = [];
  if (remaining > 0) {
    const excludePaymentIds = new Set(dbPayments.map((payment) => payment.id));
    stripeCandidates = await getStripeListCandidates(
      { since, limit: remaining },
      { excludePaymentIds }
    );
  }

  return [...dbCandidates, ...stripeCandidates].slice(0, limit);
}

/**
 * Converge a non-success target inside one transaction. Each edge is applied
 * by the state machine. CAS losers re-plan from the freshly observed status.
 */
async function convergePaymentStatus(tx, paymentId, target) {
  let payment = await tx.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new PaymentNotFoundError();

  for (let step = 0; step < MAX_CONVERGENCE_STEPS; step += 1) {
    const path = planReconciliationTransitions(payment.status, target);
    if (path.length === 0) return payment;

    const transition = await applyTransition(
      tx,
      payment.id,
      path[0],
      SYSTEM_RECONCILE_META
    );
    payment = transition.payment;
  }

  throw new PaymentTransitionError(payment.status, target, {
    paymentId,
    currentStatus: payment.status,
    detail: 'reconciliation did not converge after concurrent status changes',
  });
}

/** Apply one known mismatch while preserving canonical state/entitlement rules. */
async function applyRepair({ payment, diff, runId }) {
  const target = diff.mappedLocalStatus;

  if (target === PAYMENT_STATUSES.SUCCEEDED) {
    let current = await prisma.payment.findUnique({ where: { id: payment.id } });
    if (!current) throw new PaymentNotFoundError();

    // markPaymentCompleted owns the winner-gated succeeded transition and
    // entitlement transaction. Only failed needs trusted preparation first.
    if (current.status === PAYMENT_STATUSES.FAILED) {
      current = await prisma.$transaction((tx) =>
        convergePaymentStatus(tx, payment.id, PAYMENT_STATUSES.PENDING)
      );
    }

    // Validate terminal/concurrent state before invoking completion logic.
    planReconciliationTransitions(current.status, PAYMENT_STATUSES.SUCCEEDED);

    await markPaymentCompleted({
      paymentId: payment.id,
      subscriptionExternalId:
        diff.stripePaymentIntentId || payment.externalId,
      eventPayload: {
        source: 'reconcile',
        runId,
        stripeStatus: diff.stripeStatus,
      },
      eventIdempotencyKey: `reconcile:${runId}:${payment.id}:succeeded`,
    });

    await recordPaymentEvent({
      paymentId: payment.id,
      type: 'reconcile.repaired',
      payload: {
        runId,
        from: payment.status,
        to: PAYMENT_STATUSES.SUCCEEDED,
        stripeStatus: diff.stripeStatus,
      },
      idempotencyKey: `reconcile:${runId}:${payment.id}:repaired`,
      outcome: 'processed',
    });
    return;
  }

  await prisma.$transaction(async (tx) => {
    const repairedPayment = await convergePaymentStatus(tx, payment.id, target);
    await recordPaymentEvent({
      paymentId: payment.id,
      type: 'reconcile.repaired',
      payload: {
        runId,
        from: payment.status,
        to: repairedPayment.status,
        stripeStatus: diff.stripeStatus,
      },
      idempotencyKey: `reconcile:${runId}:${payment.id}:repaired`,
      outcome: 'processed',
      tx,
    });
  });
}

/** Process one local/Stripe pair, optionally applying the repair. */
async function processCandidate(
  { payment, stripePaymentIntent },
  { runId, apply }
) {
  const diff = buildDiff({ payment, stripePaymentIntent });

  if (!apply) {
    return { ...diff, action: diff.mismatch ? 'would_repair' : 'none' };
  }

  if (!diff.mismatch) {
    await recordPaymentEvent({
      paymentId: payment.id,
      type: 'reconcile.checked',
      payload: {
        runId,
        stripeStatus: diff.stripeStatus,
        localStatus: diff.localStatus,
      },
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
  } catch (error) {
    await recordPaymentEvent({
      paymentId: payment.id,
      type: 'reconcile.error',
      payload: {
        runId,
        message: error.message,
        code: error.code || null,
        currentStatus: error.currentStatus || null,
        targetStatus: diff.mappedLocalStatus,
      },
      idempotencyKey: `reconcile:${runId}:${payment.id}:error`,
      outcome: 'failed',
    }).catch(() => {});
    return { ...diff, action: 'error', error: error.message };
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

/** Entry point used by the reconciliation CLI. */
export async function reconcilePayments({
  since = null,
  limit = DEFAULT_LIMIT,
  paymentId = null,
  apply = false,
  runId = crypto.randomUUID(),
} = {}) {
  const candidates = paymentId
    ? [
        {
          payment: await getCandidateByPaymentId(paymentId),
          stripePaymentIntent: null,
        },
      ]
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
        candidate.stripePaymentIntent ||
        (await stripeClient.retrievePaymentIntent(
          candidate.payment.stripePaymentIntentId
        ));
      results.push(
        await processCandidate(
          { payment: candidate.payment, stripePaymentIntent },
          { runId, apply }
        )
      );
    } catch (error) {
      if (apply) {
        await recordPaymentEvent({
          paymentId: candidate.payment.id,
          type: 'reconcile.error',
          payload: {
            runId,
            message: error.message,
            stage: 'stripe_lookup',
          },
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
        error: error.message,
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
  planReconciliationTransitions,
  getDbCandidates,
  getCandidateByPaymentId,
  getStripeListCandidates,
  getCandidates,
  reconcilePayments,
};
