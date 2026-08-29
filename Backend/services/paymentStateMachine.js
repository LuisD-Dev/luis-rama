export const PAYMENT_STATUSES = Object.freeze({
  CREATED: 'created',
  PENDING: 'pending',
  PROCESSING: 'processing',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELED: 'canceled',
});

export const CANONICAL_PAYMENT_STATUSES = Object.freeze(
  Object.values(PAYMENT_STATUSES)
);

const canonicalStatusSet = new Set(CANONICAL_PAYMENT_STATUSES);

const allowedTransitions = new Map([
  [PAYMENT_STATUSES.CREATED, new Set([PAYMENT_STATUSES.PENDING])],
  [
    PAYMENT_STATUSES.PENDING,
    new Set([
      PAYMENT_STATUSES.PROCESSING,
      PAYMENT_STATUSES.FAILED,
      PAYMENT_STATUSES.CANCELED,
    ]),
  ],
  [
    PAYMENT_STATUSES.PROCESSING,
    new Set([
      PAYMENT_STATUSES.SUCCEEDED,
      PAYMENT_STATUSES.FAILED,
      PAYMENT_STATUSES.CANCELED,
    ]),
  ],
  [PAYMENT_STATUSES.SUCCEEDED, new Set()],
  [PAYMENT_STATUSES.FAILED, new Set([PAYMENT_STATUSES.PENDING])],
  [PAYMENT_STATUSES.CANCELED, new Set()],
]);

export class PaymentTransitionError extends Error {
  constructor(from, to, { paymentId, currentStatus, detail } = {}) {
    const suffix = detail ? `: ${detail}` : '';
    super(`Payment status transition from "${from}" to "${to}" is not allowed${suffix}`);
    this.name = 'PaymentTransitionError';
    this.statusCode = 409;
    this.code = 'PAYMENT_STATUS_CONFLICT';
    this.from = from;
    this.to = to;
    if (paymentId !== undefined) this.paymentId = paymentId;
    if (currentStatus !== undefined) this.currentStatus = currentStatus;
  }
}

export class PaymentNotFoundError extends Error {
  constructor(paymentId) {
    super(`Payment ${paymentId} not found`);
    this.name = 'PaymentNotFoundError';
    this.statusCode = 404;
    this.code = 'PAYMENT_NOT_FOUND';
    this.paymentId = paymentId;
  }
}

export const isCanonicalPaymentStatus = (status) => canonicalStatusSet.has(status);

const hasTrustedReconcileMetadata = (meta) =>
  meta?.retryKind === 'reconcile' &&
  ((meta?.source === 'admin_reconcile' && meta?.actorType === 'admin') ||
    (meta?.source === 'system_reconcile' && meta?.actorType === 'system')) &&
  typeof meta?.reason === 'string' &&
  meta.reason.trim().length > 0;

/**
 * Validate a requested status edge. A same-state request is a valid idempotent
 * observation, but is not classified as a transition.
 */
export function assertTransition(from, to, meta = undefined) {
  if (!isCanonicalPaymentStatus(from)) {
    throw new PaymentTransitionError(from, to, {
      currentStatus: from,
      detail: `unknown source status "${from}"`,
    });
  }

  if (!isCanonicalPaymentStatus(to)) {
    throw new PaymentTransitionError(from, to, {
      currentStatus: from,
      detail: `unknown target status "${to}"`,
    });
  }

  if (from === to) return false;

  if (
    from === PAYMENT_STATUSES.FAILED &&
    to === PAYMENT_STATUSES.PENDING &&
    !hasTrustedReconcileMetadata(meta)
  ) {
    throw new PaymentTransitionError(from, to, {
      currentStatus: from,
      detail: 'failed to pending requires trusted reconciliation metadata',
    });
  }

  if (!allowedTransitions.get(from)?.has(to)) {
    throw new PaymentTransitionError(from, to, { currentStatus: from });
  }

  return true;
}

const attachPaymentContext = (error, paymentId, currentStatus) => {
  if (error instanceof PaymentTransitionError) {
    error.paymentId = paymentId;
    error.currentStatus = currentStatus;
  }
  return error;
};

const buildResult = ({ applied, outcome, previousStatus, targetStatus, payment }) => ({
  applied,
  outcome,
  previousStatus,
  targetStatus,
  currentStatus: payment.status,
  payment,
});

/**
 * Apply one transition with an optimistic compare-and-set. A zero-row update
 * is reported to the caller instead of automatically following a new edge.
 */
export async function applyTransition(tx, paymentId, to, meta = undefined) {
  const payment = await tx.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new PaymentNotFoundError(paymentId);

  const previousStatus = payment.status;
  try {
    const isDifferentState = assertTransition(previousStatus, to, meta);
    if (!isDifferentState) {
      return buildResult({
        applied: false,
        outcome: 'already_at_target',
        previousStatus,
        targetStatus: to,
        payment,
      });
    }
  } catch (error) {
    throw attachPaymentContext(error, paymentId, previousStatus);
  }

  const result = await tx.payment.updateMany({
    where: {
      id: paymentId,
      status: previousStatus,
    },
    data: {
      status: to,
    },
  });

  const currentPayment = await tx.payment.findUnique({ where: { id: paymentId } });
  if (!currentPayment) throw new PaymentNotFoundError(paymentId);

  if (result.count === 1) {
    return buildResult({
      applied: true,
      outcome: 'applied',
      previousStatus,
      targetStatus: to,
      payment: currentPayment,
    });
  }

  return buildResult({
    applied: false,
    outcome: currentPayment.status === to ? 'already_at_target' : 'state_changed',
    previousStatus,
    targetStatus: to,
    payment: currentPayment,
  });
}

/**
 * Create a Payment at the canonical initial state and advance it to pending on
 * the caller's Prisma transaction/client. Callers cannot select the initial
 * status and remain responsible for opening/committing any transaction.
 */
export async function createPaymentInPendingState(tx, data, meta = undefined) {
  if (!tx?.payment || typeof tx.payment.create !== 'function') {
    throw new TypeError('A Prisma transaction/client with payment.create is required');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('Payment data is required');
  }

  const { status: _ignoredStatus, ...paymentData } = data;
  const created = await tx.payment.create({
    data: {
      ...paymentData,
      status: PAYMENT_STATUSES.CREATED,
    },
  });
  const transition = await applyTransition(
    tx,
    created.id,
    PAYMENT_STATUSES.PENDING,
    meta
  );
  return transition.payment;
}

export default {
  PAYMENT_STATUSES,
  CANONICAL_PAYMENT_STATUSES,
  PaymentTransitionError,
  PaymentNotFoundError,
  isCanonicalPaymentStatus,
  assertTransition,
  applyTransition,
  createPaymentInPendingState,
};
