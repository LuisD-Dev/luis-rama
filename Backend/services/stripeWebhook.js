import Stripe from 'stripe';

export const DEFAULT_STRIPE_WEBHOOK_TOLERANCE_SEC = 300;

// Signature verification is an offline SDK operation. This placeholder is
// deliberately not sourced from STRIPE_SECRET_KEY and is never sent to Stripe.
const stripe = new Stripe('sk_test_offline_webhook_verification_placeholder');

export class StripeWebhookConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StripeWebhookConfigError';
    this.code = 'STRIPE_WEBHOOK_CONFIG_ERROR';
    this.statusCode = 503;
  }
}

export class StripeWebhookPipelineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StripeWebhookPipelineError';
    this.code = 'STRIPE_WEBHOOK_PIPELINE_ERROR';
    this.statusCode = 500;
  }
}

export class StripeWebhookVerificationError extends Error {
  constructor(cause) {
    super('Stripe webhook signature or payload verification failed.');
    this.name = 'StripeWebhookVerificationError';
    this.code = 'STRIPE_WEBHOOK_VERIFICATION_ERROR';
    this.statusCode = 400;
    this.cause = cause;
  }
}

const parseTolerance = (rawTolerance) => {
  if (rawTolerance === undefined) {
    return DEFAULT_STRIPE_WEBHOOK_TOLERANCE_SEC;
  }

  if (
    typeof rawTolerance !== 'string' ||
    !/^[1-9]\d*$/.test(rawTolerance)
  ) {
    throw new StripeWebhookConfigError(
      'STRIPE_WEBHOOK_TOLERANCE_SEC must be a positive integer.'
    );
  }

  const toleranceSeconds = Number(rawTolerance);
  if (!Number.isSafeInteger(toleranceSeconds)) {
    throw new StripeWebhookConfigError(
      'STRIPE_WEBHOOK_TOLERANCE_SEC must be a safe positive integer.'
    );
  }

  return toleranceSeconds;
};

/**
 * Validate webhook configuration without mutating process.env.
 *
 * The application can call this during production startup. The verifier also
 * calls it for every request so non-production environments fail closed at the
 * endpoint when no signing secret is configured.
 */
export function assertStripeWebhookConfig(env = process.env) {
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (typeof webhookSecret !== 'string' || webhookSecret.trim() === '') {
    throw new StripeWebhookConfigError(
      'STRIPE_WEBHOOK_SECRET is required to verify Stripe webhooks.'
    );
  }

  const toleranceSeconds = parseTolerance(
    env.STRIPE_WEBHOOK_TOLERANCE_SEC
  );

  if (
    env.NODE_ENV === 'production' &&
    env.VERCEL === '1' &&
    env.NODEJS_HELPERS !== '0'
  ) {
    throw new StripeWebhookConfigError(
      "NODEJS_HELPERS must be '0' for Stripe webhooks on Vercel production."
    );
  }

  return { webhookSecret, toleranceSeconds };
}

/**
 * Verify the exact bytes signed by Stripe and return the SDK-parsed event.
 */
export function verifyAndParse(rawBody, signatureHeader) {
  const { webhookSecret, toleranceSeconds } = assertStripeWebhookConfig();

  if (!Buffer.isBuffer(rawBody)) {
    throw new StripeWebhookPipelineError(
      'Stripe webhook raw body must be an unmodified Buffer.'
    );
  }

  try {
    return stripe.webhooks.constructEvent(
      rawBody,
      signatureHeader,
      webhookSecret,
      toleranceSeconds
    );
  } catch (error) {
    throw new StripeWebhookVerificationError(error);
  }
}

export default {
  assertStripeWebhookConfig,
  verifyAndParse,
};
