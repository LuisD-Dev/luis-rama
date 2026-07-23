import crypto from 'crypto';
import https from 'https';
import Stripe from 'stripe';
import prisma from '../utils/prismaClient.js';
import { PLAN_TIERS, normalizePlanTier } from '../utils/plans.js';

const STRIPE_API_BASE = 'api.stripe.com';

const PLAN_AMOUNTS = {
  [PLAN_TIERS.BASICO]: 999,
  [PLAN_TIERS.PRO]: 2499,
  [PLAN_TIERS.MASTER]: 4999,
};

const PAID_PLAN_TIERS = new Set([
  PLAN_TIERS.BASICO,
  PLAN_TIERS.PRO,
  PLAN_TIERS.MASTER,
]);

const PRICE_ENV_BY_PLAN = {
  [PLAN_TIERS.BASICO]: 'STRIPE_PRICE_BASICO',
  [PLAN_TIERS.PRO]: 'STRIPE_PRICE_PRO',
  [PLAN_TIERS.MASTER]: 'STRIPE_PRICE_MASTER',
};

const DEFAULT_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

const SUBSCRIPTION_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

export class PaymentServiceError extends Error {
  constructor(message, { statusCode = 502, clientMessage } = {}) {
    super(message);
    this.name = 'PaymentServiceError';
    this.statusCode = statusCode;
    this.clientMessage = clientMessage || message;
  }
}

export class InvalidPlanError extends PaymentServiceError {
  constructor(planTier) {
    super(`Invalid plan tier: ${planTier}`, {
      statusCode: 400,
      clientMessage: `Plan no válido. Opciones: basico, pro, master`,
    });
    this.name = 'InvalidPlanError';
  }
}

export class PaymentNotFoundError extends PaymentServiceError {
  constructor() {
    super('Payment not found', {
      statusCode: 404,
      clientMessage: 'Payment not found',
    });
    this.name = 'PaymentNotFoundError';
  }
}

const getStripeSecret = () => process.env.STRIPE_SECRET_KEY || '';

let cachedStripeClient = null;
let cachedStripeClientKey = null;

/**
 * Lazily construct a Stripe SDK client. Used only for local/offline operations
 * (webhook signature construction) — the rest of this module talks to Stripe
 * over raw HTTPS via `stripeRequest`. A placeholder key is used when
 * STRIPE_SECRET_KEY is not configured (e.g. tests), since signature
 * verification does not make network calls.
 */
export const getStripeClient = () => {
  const key = getStripeSecret() || 'sk_test_placeholder_key_for_signature_verification';
  if (!cachedStripeClient || cachedStripeClientKey !== key) {
    cachedStripeClient = new Stripe(key);
    cachedStripeClientKey = key;
  }
  return cachedStripeClient;
};

/**
 * Verify a Stripe webhook request and return the parsed event.
 * Throws Stripe.errors.StripeSignatureVerificationError on invalid/missing signature.
 */
export function constructStripeEvent(rawBody, signatureHeader) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new PaymentServiceError('Missing STRIPE_WEBHOOK_SECRET', {
      statusCode: 500,
      clientMessage: 'Webhook not configured',
    });
  }
  return getStripeClient().webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
}

const resolvePlanTierForPriceId = (priceId) => {
  if (!priceId) return null;
  for (const [plan, envKey] of Object.entries(PRICE_ENV_BY_PLAN)) {
    if (process.env[envKey] && process.env[envKey] === priceId) {
      return plan;
    }
  }
  return null;
};

const toDateFromUnixSeconds = (unixSeconds) =>
  typeof unixSeconds === 'number' ? new Date(unixSeconds * 1000) : null;

const mapStripeSubscriptionStatus = (stripeStatus) => {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
    default:
      return 'past_due';
  }
};

const stripeRequest = ({ path, method = 'POST', body, idempotencyKey }) =>
  new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString();
    const stripeSecret = getStripeSecret();
    const options = {
      hostname: STRIPE_API_BASE,
      path,
      method,
      headers: {
        Authorization: `Bearer ${stripeSecret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            reject(parsed);
          }
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.write(data);
    req.end();
  });

const resolvePriceId = (plan) => {
  const envKey = PRICE_ENV_BY_PLAN[plan];
  if (!envKey) return null;
  return process.env[envKey] || null;
};

const assertPaidPlan = (planTier) => {
  const normalized = normalizePlanTier(planTier);
  if (!normalized || !PAID_PLAN_TIERS.has(normalized)) {
    throw new InvalidPlanError(planTier);
  }
  return normalized;
};

const serializeMetadata = (metadata) => {
  if (metadata == null) return null;
  if (typeof metadata === 'string') return metadata;
  return JSON.stringify(metadata);
};

/**
 * Persist a pending payment intent row. Idempotent on `idempotencyKey`.
 */
export async function createPaymentIntent({
  userId,
  planTier,
  amount,
  currency = 'usd',
  provider = 'stripe',
  externalId = null,
  idempotencyKey,
  metadata = null,
  paymentMethodId = null,
  stripePaymentIntentId = null,
  stripeCheckoutSessionId = null,
  tx = prisma,
} = {}) {
  if (!idempotencyKey) {
    throw new PaymentServiceError('idempotencyKey required', {
      statusCode: 400,
      clientMessage: 'idempotencyKey is required',
    });
  }

  const normalizedPlan = assertPaidPlan(planTier);
  const amountCents =
    typeof amount === 'number' ? amount : PLAN_AMOUNTS[normalizedPlan] ?? 0;

  const existing = await tx.payment.findUnique({ where: { idempotencyKey } });
  if (existing) return existing;

  try {
    return await tx.payment.create({
      data: {
        userId,
        amount: amountCents,
        currency,
        planTier: normalizedPlan,
        provider,
        externalId,
        paymentMethodId,
        stripePaymentIntentId,
        stripeCheckoutSessionId,
        idempotencyKey,
        metadata: serializeMetadata(metadata),
        status: 'pending',
      },
    });
  } catch (err) {
    if (err?.code === 'P2002') {
      const raced = await tx.payment.findUnique({ where: { idempotencyKey } });
      if (raced) return raced;
    }
    throw err;
  }
}

/**
 * Append a payment audit event. Idempotent on `idempotencyKey` (and `stripeEventId` when set).
 * Returns `{ event, created }`.
 */
export async function recordPaymentEvent({
  paymentId = null,
  type,
  payload,
  idempotencyKey,
  stripeEventId = null,
  outcome = null,
  processedAt = new Date(),
  tx = prisma,
} = {}) {
  if (!idempotencyKey) {
    throw new PaymentServiceError('idempotencyKey required', {
      statusCode: 400,
      clientMessage: 'idempotencyKey is required',
    });
  }
  if (!type) {
    throw new PaymentServiceError('event type required', {
      statusCode: 400,
      clientMessage: 'event type is required',
    });
  }

  const existing = await tx.paymentEvent.findUnique({
    where: { idempotencyKey },
  });
  if (existing) return { event: existing, created: false };

  if (stripeEventId) {
    const byStripe = await tx.paymentEvent.findUnique({
      where: { stripeEventId },
    });
    if (byStripe) return { event: byStripe, created: false };
  }

  try {
    const event = await tx.paymentEvent.create({
      data: {
        paymentId,
        type,
        payload:
          typeof payload === 'string' ? payload : JSON.stringify(payload ?? {}),
        idempotencyKey,
        stripeEventId,
        outcome,
        processedAt,
      },
    });
    return { event, created: true };
  } catch (err) {
    // Unique race: re-fetch and treat as duplicate
    if (err?.code === 'P2002') {
      const raced =
        (await tx.paymentEvent.findUnique({ where: { idempotencyKey } })) ||
        (stripeEventId
          ? await tx.paymentEvent.findUnique({ where: { stripeEventId } })
          : null);
      if (raced) return { event: raced, created: false };
    }
    throw err;
  }
}

const resolvePayment = async (tx, { paymentId, idempotencyKey, externalId }) => {
  if (paymentId != null) {
    const byId = await tx.payment.findUnique({ where: { id: Number(paymentId) } });
    if (byId) return byId;
  }
  if (idempotencyKey) {
    const byKey = await tx.payment.findUnique({ where: { idempotencyKey } });
    if (byKey) return byKey;
  }
  if (externalId) {
    const byExternal = await tx.payment.findFirst({ where: { externalId } });
    if (byExternal) return byExternal;
  }
  return null;
};

/**
 * Mark a payment completed and activate the user's subscription/plan in one transaction.
 */
export async function markPaymentCompleted({
  paymentId,
  idempotencyKey,
  externalId,
  subscriptionExternalId,
  currentPeriodStart,
  currentPeriodEnd,
  eventPayload = null,
  eventIdempotencyKey = null,
} = {}) {
  return prisma.$transaction(async (tx) => {
    const payment = await resolvePayment(tx, {
      paymentId,
      idempotencyKey,
      externalId,
    });

    if (!payment) {
      throw new PaymentNotFoundError();
    }

    if (payment.status === 'completed' || payment.status === 'processed') {
      return {
        payment,
        subscription: await tx.subscription.findFirst({
          where: {
            userId: payment.userId,
            provider: payment.provider,
            status: 'active',
          },
          orderBy: { id: 'desc' },
        }),
        alreadyCompleted: true,
      };
    }

    const now = new Date();
    const periodStart = currentPeriodStart
      ? new Date(currentPeriodStart)
      : now;
    const periodEnd = currentPeriodEnd
      ? new Date(currentPeriodEnd)
      : new Date(periodStart.getTime() + DEFAULT_PERIOD_MS);

    const subExternalId =
      subscriptionExternalId ||
      payment.externalId ||
      payment.stripePaymentIntentId ||
      payment.stripeCheckoutSessionId ||
      `payment_${payment.id}`;

    const updatedPayment = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'completed',
        externalId: payment.externalId || subExternalId,
        updatedAt: now,
      },
    });

    const existingSub = await tx.subscription.findUnique({
      where: {
        provider_externalId: {
          provider: payment.provider,
          externalId: subExternalId,
        },
      },
    });

    const subscription = existingSub
      ? await tx.subscription.update({
          where: { id: existingSub.id },
          data: {
            planTier: payment.planTier,
            status: 'active',
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
          },
        })
      : await tx.subscription.create({
          data: {
            userId: payment.userId,
            planTier: payment.planTier,
            status: 'active',
            provider: payment.provider,
            externalId: subExternalId,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
          },
        });

    await tx.user.update({
      where: { id: payment.userId },
      data: {
        planTier: payment.planTier,
        role: 'premium',
      },
    });

    await recordPaymentEvent({
      paymentId: payment.id,
      type: 'payment.completed',
      payload: eventPayload ?? {
        paymentId: payment.id,
        planTier: payment.planTier,
        subscriptionId: subscription.id,
      },
      idempotencyKey:
        eventIdempotencyKey || `payment.completed:${payment.id}`,
      outcome: 'processed',
      processedAt: now,
      tx,
    });

    return {
      payment: updatedPayment,
      subscription,
      alreadyCompleted: false,
    };
  });
}

/** Convenience: unwrap recordPaymentEvent for callers that only need the row. */
export async function ensurePaymentEvent(args) {
  const { event } = await recordPaymentEvent(args);
  return event;
}

export async function updatePaymentEventOutcome(
  eventId,
  { paymentId, outcome, processedAt = new Date() }
) {
  return prisma.paymentEvent.update({
    where: { id: eventId },
    data: {
      ...(paymentId != null ? { paymentId } : {}),
      outcome,
      processedAt,
    },
  });
}

const writeAuditLog = (
  tx,
  { actor = 'stripe-webhook', action, entityType, entityId = null, before = null, after = null }
) =>
  tx.auditLog.create({
    data: {
      actor,
      action,
      entityType,
      entityId,
      beforeState: before == null ? null : JSON.stringify(before),
      afterState: after == null ? null : JSON.stringify(after),
    },
  });

const applyUserEntitlements = (tx, { userId, planTier, role }) =>
  tx.user.update({ where: { id: userId }, data: { planTier, role } });

const findLocalSubscriptionByExternalId = (tx, externalId) =>
  tx.subscription.findUnique({
    where: { provider_externalId: { provider: 'stripe', externalId } },
  });

const upsertLocalSubscription = async (
  tx,
  { userId, planTier, status, externalId, currentPeriodStart, currentPeriodEnd }
) => {
  const existing = await findLocalSubscriptionByExternalId(tx, externalId);
  if (existing) {
    return tx.subscription.update({
      where: { id: existing.id },
      data: { planTier, status, currentPeriodStart, currentPeriodEnd },
    });
  }
  return tx.subscription.create({
    data: {
      userId,
      planTier,
      status,
      provider: 'stripe',
      externalId,
      currentPeriodStart,
      currentPeriodEnd,
    },
  });
};

/**
 * checkout.session.completed — only meaningful for mode:'subscription' sessions
 * created by createCheckoutSession. Activates the local Subscription + user
 * entitlements and captures the Stripe customer id for later webhook lookups.
 */
async function handleCheckoutSessionCompleted(tx, session) {
  if (session.mode !== 'subscription' || !session.subscription) {
    return { outcome: 'ignored' };
  }

  const metaPaymentId = Number.parseInt(String(session.metadata?.paymentId || ''), 10) || null;
  const payment =
    (metaPaymentId && (await tx.payment.findUnique({ where: { id: metaPaymentId } }))) ||
    (session.id && (await tx.payment.findUnique({ where: { stripeCheckoutSessionId: session.id } })));

  const userId = payment?.userId || Number.parseInt(String(session.client_reference_id || ''), 10) || null;
  const planTier = payment?.planTier || null;

  if (!userId || !planTier) {
    return { outcome: 'ignored' };
  }

  const beforeUser = await tx.user.findUnique({ where: { id: userId } });
  if (!beforeUser) {
    return { outcome: 'ignored' };
  }

  if (session.customer && beforeUser.stripeCustomerId !== session.customer) {
    await tx.user.update({ where: { id: userId }, data: { stripeCustomerId: session.customer } });
  }

  if (payment && payment.status !== 'completed') {
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'completed', externalId: session.subscription },
    });
  }

  const now = new Date();
  const subscription = await upsertLocalSubscription(tx, {
    userId,
    planTier,
    status: 'active',
    externalId: session.subscription,
    currentPeriodStart: now,
    currentPeriodEnd: new Date(now.getTime() + DEFAULT_PERIOD_MS),
  });

  const afterUser = await applyUserEntitlements(tx, { userId, planTier, role: 'premium' });

  await writeAuditLog(tx, {
    action: 'checkout.session.completed',
    entityType: 'subscription',
    entityId: subscription.id,
    before: { planTier: beforeUser.planTier, role: beforeUser.role },
    after: { planTier: afterUser.planTier, role: afterUser.role, subscriptionStatus: subscription.status },
  });

  return { outcome: 'processed' };
}

/** invoice.paid — renewal succeeded: keep the subscription active and extend the period. */
async function handleInvoicePaid(tx, invoice) {
  const subscription = invoice.subscription && (await findLocalSubscriptionByExternalId(tx, invoice.subscription));
  if (!subscription) {
    return { outcome: 'ignored' };
  }

  const beforeUser = await tx.user.findUnique({ where: { id: subscription.userId } });

  const updatedSub = await tx.subscription.update({
    where: { id: subscription.id },
    data: {
      status: 'active',
      currentPeriodStart: toDateFromUnixSeconds(invoice.period_start) || subscription.currentPeriodStart,
      currentPeriodEnd: toDateFromUnixSeconds(invoice.period_end) || subscription.currentPeriodEnd,
    },
  });

  const afterUser = await applyUserEntitlements(tx, {
    userId: subscription.userId,
    planTier: subscription.planTier,
    role: 'premium',
  });

  await writeAuditLog(tx, {
    action: 'invoice.paid',
    entityType: 'subscription',
    entityId: updatedSub.id,
    before: { status: subscription.status, planTier: beforeUser?.planTier, role: beforeUser?.role },
    after: { status: updatedSub.status, planTier: afterUser.planTier, role: afterUser.role },
  });

  return { outcome: 'processed' };
}

/**
 * invoice.payment_failed — mark the subscription past_due. Entitlements are left
 * untouched (grace period); only customer.subscription.deleted downgrades the user.
 */
async function handleInvoicePaymentFailed(tx, invoice) {
  const subscription = invoice.subscription && (await findLocalSubscriptionByExternalId(tx, invoice.subscription));
  if (!subscription) {
    return { outcome: 'ignored' };
  }

  const updatedSub = await tx.subscription.update({
    where: { id: subscription.id },
    data: { status: 'past_due' },
  });

  await writeAuditLog(tx, {
    action: 'invoice.payment_failed',
    entityType: 'subscription',
    entityId: updatedSub.id,
    before: { status: subscription.status },
    after: { status: updatedSub.status },
  });

  return { outcome: 'processed' };
}

/**
 * customer.subscription.updated — sync plan/status/period from Stripe's source of
 * truth. Resolves the owning user via the local Subscription row, falling back to
 * User.stripeCustomerId for the first event seen for a given subscription.
 */
async function handleSubscriptionUpdated(tx, sub) {
  const priceId = sub.items?.data?.[0]?.price?.id || null;
  const planTierFromPrice = resolvePlanTierForPriceId(priceId);
  const mappedStatus = mapStripeSubscriptionStatus(sub.status);

  const localSub = await findLocalSubscriptionByExternalId(tx, sub.id);
  let userId = localSub?.userId || null;

  if (!userId && sub.customer) {
    const user = await tx.user.findUnique({ where: { stripeCustomerId: sub.customer } });
    userId = user?.id || null;
  }

  const planTier = planTierFromPrice || localSub?.planTier || null;

  if (!userId || !planTier) {
    return { outcome: 'ignored' };
  }

  const beforeUser = await tx.user.findUnique({ where: { id: userId } });

  const updatedSub = await upsertLocalSubscription(tx, {
    userId,
    planTier,
    status: mappedStatus,
    externalId: sub.id,
    currentPeriodStart: toDateFromUnixSeconds(sub.current_period_start) || new Date(),
    currentPeriodEnd:
      toDateFromUnixSeconds(sub.current_period_end) || new Date(Date.now() + DEFAULT_PERIOD_MS),
  });

  let afterUser = beforeUser;
  if (mappedStatus === 'active') {
    afterUser = await applyUserEntitlements(tx, { userId, planTier, role: 'premium' });
  } else if (mappedStatus === 'canceled') {
    afterUser = await applyUserEntitlements(tx, { userId, planTier: null, role: 'student' });
  }
  // past_due: leave entitlements untouched (grace period)

  await writeAuditLog(tx, {
    action: 'customer.subscription.updated',
    entityType: 'subscription',
    entityId: updatedSub.id,
    before: { status: localSub?.status, planTier: beforeUser?.planTier, role: beforeUser?.role },
    after: { status: updatedSub.status, planTier: afterUser.planTier, role: afterUser.role },
  });

  return { outcome: 'processed' };
}

/** customer.subscription.deleted — subscription fully canceled: downgrade the user. */
async function handleSubscriptionDeleted(tx, sub) {
  const localSub = await findLocalSubscriptionByExternalId(tx, sub.id);
  if (!localSub) {
    return { outcome: 'ignored' };
  }

  const beforeUser = await tx.user.findUnique({ where: { id: localSub.userId } });

  const updatedSub = await tx.subscription.update({
    where: { id: localSub.id },
    data: { status: 'canceled' },
  });

  const afterUser = await applyUserEntitlements(tx, {
    userId: localSub.userId,
    planTier: null,
    role: 'student',
  });

  await writeAuditLog(tx, {
    action: 'customer.subscription.deleted',
    entityType: 'subscription',
    entityId: updatedSub.id,
    before: { status: localSub.status, planTier: beforeUser?.planTier, role: beforeUser?.role },
    after: { status: updatedSub.status, planTier: afterUser.planTier, role: afterUser.role },
  });

  return { outcome: 'processed' };
}

/**
 * Process one verified Stripe webhook event. Records the event, applies its
 * effect, and writes an audit log entry, all inside a single transaction:
 * a mid-transaction failure rolls back everything, including the PaymentEvent
 * insert, so a retried delivery is not mistaken for a duplicate.
 *
 * Idempotency relies on the `payment_events.stripe_event_id` UNIQUE constraint
 * (caught as P2002) rather than a prior findFirst, to avoid a check-then-insert race.
 */
export async function processStripeWebhookEvent(event) {
  const stripeEventId = event?.id;
  const eventType = event?.type;

  if (!stripeEventId || !eventType) {
    throw new PaymentServiceError('Malformed Stripe event', {
      statusCode: 400,
      clientMessage: 'Malformed Stripe event',
    });
  }

  return prisma.$transaction(async (tx) => {
    let paymentEvent;
    try {
      paymentEvent = await tx.paymentEvent.create({
        data: {
          type: eventType,
          payload: JSON.stringify(event),
          idempotencyKey: `stripe_sub:${stripeEventId}`,
          stripeEventId,
          outcome: 'processing',
          processedAt: null,
        },
      });
    } catch (err) {
      if (err?.code === 'P2002') {
        return { outcome: 'duplicate', eventType };
      }
      throw err;
    }

    if (!SUBSCRIPTION_EVENT_TYPES.has(eventType)) {
      await tx.paymentEvent.update({
        where: { id: paymentEvent.id },
        data: { outcome: 'ignored', processedAt: new Date() },
      });
      return { outcome: 'ignored', eventType };
    }

    const object = event.data?.object || {};
    let result;
    switch (eventType) {
      case 'checkout.session.completed':
        result = await handleCheckoutSessionCompleted(tx, object);
        break;
      case 'invoice.paid':
        result = await handleInvoicePaid(tx, object);
        break;
      case 'invoice.payment_failed':
        result = await handleInvoicePaymentFailed(tx, object);
        break;
      case 'customer.subscription.updated':
        result = await handleSubscriptionUpdated(tx, object);
        break;
      case 'customer.subscription.deleted':
        result = await handleSubscriptionDeleted(tx, object);
        break;
      default:
        result = { outcome: 'ignored' };
    }

    await tx.paymentEvent.update({
      where: { id: paymentEvent.id },
      data: { outcome: result.outcome, processedAt: new Date() },
    });

    return { outcome: result.outcome, eventType };
  });
}

export async function findPaymentForStripeWebhook({
  stripePaymentIntentId,
  paymentId,
  idempotencyKey,
}) {
  if (stripePaymentIntentId) {
    const byPi = await prisma.payment.findUnique({
      where: { stripePaymentIntentId },
    });
    if (byPi) return byPi;
  }
  if (paymentId) {
    const byId = await prisma.payment.findUnique({
      where: { id: Number(paymentId) },
    });
    if (byId) return byId;
  }
  if (idempotencyKey) {
    return prisma.payment.findUnique({ where: { idempotencyKey } });
  }
  return null;
}

/** @deprecated Prefer markPaymentCompleted — kept for callers expecting status "processed". */
export async function markPaymentProcessed({ paymentId }) {
  const result = await markPaymentCompleted({ paymentId });
  return result.payment;
}

export async function createOrReusePayment({
  userId,
  paymentMethodId,
  planTier,
  idempotencyKey,
}) {
  if (!idempotencyKey) throw new Error('idempotencyKey required');

  const normalizedPlan = assertPaidPlan(planTier);
  const amount = PLAN_AMOUNTS[normalizedPlan] ?? 0;
  const stripeSecret = getStripeSecret();

  return prisma.$transaction(async (tx) => {
    const payment = await createPaymentIntent({
      userId,
      planTier: normalizedPlan,
      amount,
      currency: 'usd',
      provider: 'stripe',
      paymentMethodId,
      idempotencyKey,
      metadata: { source: 'payment_method' },
      tx,
    });

    if (payment.stripePaymentIntentId) {
      return payment;
    }

    try {
      if (!stripeSecret && process.env.NODE_ENV === 'test') {
        const stripeId = `test_pi_${payment.id}_${Date.now()}`;
        return tx.payment.update({
          where: { id: payment.id },
          data: { stripePaymentIntentId: stripeId, externalId: stripeId },
        });
      }

      const body = {
        amount: String(amount),
        currency: 'usd',
        payment_method: paymentMethodId,
        confirm: 'true',
        'metadata[paymentId]': String(payment.id),
        'metadata[idempotencyKey]': idempotencyKey,
      };

      const res = await stripeRequest({
        path: '/v1/payment_intents',
        body,
        idempotencyKey,
      });
      const stripeId = res.id;

      const updated = await tx.payment.update({
        where: { id: payment.id },
        data: { stripePaymentIntentId: stripeId, externalId: stripeId },
      });

      console.info(
        {
          userId,
          paymentId: updated.id,
          stripePaymentIntentId: stripeId,
          idempotencyKey,
          outcome: 'processed',
          timestamp: new Date().toISOString(),
        },
        'Stripe payment intent created'
      );

      return updated;
    } catch (err) {
      await tx.payment
        .update({ where: { id: payment.id }, data: { status: 'failed' } })
        .catch(() => {});
      throw err;
    }
  });
}

/**
 * Create a Stripe Checkout Session for the given plan and persist a pending Payment.
 * @returns {{ checkoutUrl: string, sessionId: string, payment: object }}
 */
export async function createCheckoutSession({ userId, plan }) {
  const normalizedPlan = assertPaidPlan(plan);
  const priceId = resolvePriceId(normalizedPlan);
  if (!priceId) {
    throw new PaymentServiceError(
      `Missing Stripe price configuration for plan "${normalizedPlan}"`,
      {
        statusCode: 400,
        clientMessage: `No Stripe price configured for plan "${normalizedPlan}". Set ${PRICE_ENV_BY_PLAN[normalizedPlan] || 'STRIPE_PRICE_*'}.`,
      }
    );
  }

  const successUrl = process.env.STRIPE_CHECKOUT_SUCCESS_URL;
  const cancelUrl = process.env.STRIPE_CHECKOUT_CANCEL_URL;
  if (!successUrl || !cancelUrl) {
    throw new PaymentServiceError(
      'Missing Stripe checkout success/cancel URLs',
      {
        statusCode: 400,
        clientMessage:
          'Checkout URLs are not configured. Set STRIPE_CHECKOUT_SUCCESS_URL and STRIPE_CHECKOUT_CANCEL_URL.',
      }
    );
  }

  const amount = PLAN_AMOUNTS[normalizedPlan] ?? 0;
  const idempotencyKey = `checkout_${userId}_${normalizedPlan}_${crypto.randomUUID()}`;
  const stripeSecret = getStripeSecret();

  const payment = await createPaymentIntent({
    userId,
    planTier: normalizedPlan,
    amount,
    currency: 'usd',
    provider: 'stripe',
    idempotencyKey,
    metadata: { source: 'checkout' },
  });

  try {
    if (!stripeSecret && process.env.NODE_ENV === 'test') {
      const sessionId = `cs_test_${payment.id}_${Date.now()}`;
      const checkoutUrl = `https://checkout.stripe.com/c/pay/${sessionId}`;
      const updated = await prisma.payment.update({
        where: { id: payment.id },
        data: {
          stripeCheckoutSessionId: sessionId,
          externalId: sessionId,
        },
      });
      return { checkoutUrl, sessionId, payment: updated };
    }

    if (process.env.NODE_ENV === 'test' && stripeSecret === 'sk_test_force_error') {
      const simulated = {
        error: { type: 'api_error', message: 'Simulated Stripe API failure' },
      };
      console.error(
        { paymentId: payment.id, stripeError: simulated },
        'Stripe checkout session failed'
      );
      await prisma.payment
        .update({ where: { id: payment.id }, data: { status: 'failed' } })
        .catch(() => {});
      throw new PaymentServiceError('Stripe checkout session failed', {
        statusCode: 502,
        clientMessage: 'Unable to start checkout. Please try again.',
      });
    }

    const body = {
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: String(userId),
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'metadata[paymentId]': String(payment.id),
      'metadata[planTier]': normalizedPlan,
    };

    const session = await stripeRequest({
      path: '/v1/checkout/sessions',
      body,
      idempotencyKey,
    });

    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        stripeCheckoutSessionId: session.id,
        externalId: session.id,
      },
    });

    console.info(
      {
        userId,
        paymentId: updated.id,
        stripeCheckoutSessionId: session.id,
        plan: normalizedPlan,
        outcome: 'checkout_session_created',
        timestamp: new Date().toISOString(),
      },
      'Stripe checkout session created'
    );

    return {
      checkoutUrl: session.url,
      sessionId: session.id,
      payment: updated,
    };
  } catch (err) {
    if (err instanceof PaymentServiceError) throw err;

    console.error(
      {
        paymentId: payment.id,
        userId,
        plan: normalizedPlan,
        stripeError: err,
        timestamp: new Date().toISOString(),
      },
      'Stripe checkout session failed'
    );

    await prisma.payment
      .update({ where: { id: payment.id }, data: { status: 'failed' } })
      .catch(() => {});

    throw new PaymentServiceError('Stripe checkout session failed', {
      statusCode: 502,
      clientMessage: 'Unable to start checkout. Please try again.',
    });
  }
}

export default {
  createPaymentIntent,
  markPaymentCompleted,
  recordPaymentEvent,
  ensurePaymentEvent,
  updatePaymentEventOutcome,
  findPaymentForStripeWebhook,
  createOrReusePayment,
  createCheckoutSession,
  markPaymentProcessed,
  getStripeClient,
  constructStripeEvent,
  processStripeWebhookEvent,
  PaymentServiceError,
  InvalidPlanError,
  PaymentNotFoundError,
};
