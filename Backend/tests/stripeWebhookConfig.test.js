import { spawnSync } from 'node:child_process';
import Stripe from 'stripe';
import {
  DEFAULT_STRIPE_WEBHOOK_TOLERANCE_SEC,
  StripeWebhookConfigError,
  StripeWebhookPipelineError,
  StripeWebhookVerificationError,
  assertStripeWebhookConfig,
  verifyAndParse,
} from '../services/stripeWebhook.js';

const WEBHOOK_SECRET = 'whsec_offline_unit_test_secret';
const stripe = new Stripe('sk_test_offline_webhook_test_placeholder');
const payload = JSON.stringify({
  id: 'evt_webhook_verifier_unit_test',
  object: 'event',
  type: 'payment_intent.succeeded',
  data: { object: { id: 'pi_webhook_verifier_unit_test' } },
});

const savedEnv = {
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  STRIPE_WEBHOOK_TOLERANCE_SEC: process.env.STRIPE_WEBHOOK_TOLERANCE_SEC,
};

const restoreEnv = (key, value) => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

const importProductionApp = (overrides = {}) => {
  const env = {
    ...process.env,
    DOTENV_CONFIG_PATH: '__stripe_webhook_test_env_does_not_exist__.env',
    NODE_ENV: 'production',
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }

  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', "import('./app.js')"],
    {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
    }
  );
};

afterEach(() => {
  restoreEnv('STRIPE_WEBHOOK_SECRET', savedEnv.STRIPE_WEBHOOK_SECRET);
  restoreEnv(
    'STRIPE_WEBHOOK_TOLERANCE_SEC',
    savedEnv.STRIPE_WEBHOOK_TOLERANCE_SEC
  );
});

describe('Stripe webhook configuration', () => {
  test('uses a 300 second tolerance by default', () => {
    expect(
      assertStripeWebhookConfig({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET })
    ).toEqual({
      webhookSecret: WEBHOOK_SECRET,
      toleranceSeconds: DEFAULT_STRIPE_WEBHOOK_TOLERANCE_SEC,
    });
  });

  test('accepts a configured positive integer tolerance', () => {
    expect(
      assertStripeWebhookConfig({
        STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
        STRIPE_WEBHOOK_TOLERANCE_SEC: '45',
      }).toleranceSeconds
    ).toBe(45);
  });

  test.each(['', '0', '-1', '1.5', ' 300', '300 ', 'abc'])(
    'rejects malformed tolerance %p',
    (value) => {
      expect(() =>
        assertStripeWebhookConfig({
          STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
          STRIPE_WEBHOOK_TOLERANCE_SEC: value,
        })
      ).toThrow(StripeWebhookConfigError);
    }
  );

  test('rejects production configuration without a signing secret', () => {
    expect(() =>
      assertStripeWebhookConfig({ NODE_ENV: 'production' })
    ).toThrow(StripeWebhookConfigError);
  });

  test('requires raw-body helpers to be disabled on Vercel production', () => {
    const baseEnv = {
      NODE_ENV: 'production',
      VERCEL: '1',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    };

    expect(() => assertStripeWebhookConfig(baseEnv)).toThrow(
      StripeWebhookConfigError
    );
    expect(() =>
      assertStripeWebhookConfig({ ...baseEnv, NODEJS_HELPERS: '1' })
    ).toThrow(StripeWebhookConfigError);
    expect(
      assertStripeWebhookConfig({ ...baseEnv, NODEJS_HELPERS: '0' })
        .toleranceSeconds
    ).toBe(DEFAULT_STRIPE_WEBHOOK_TOLERANCE_SEC);
  });
});

describe('production application startup assertion', () => {
  test('aborts startup when STRIPE_WEBHOOK_SECRET is missing', () => {
    const result = importProductionApp({
      STRIPE_WEBHOOK_SECRET: undefined,
      VERCEL: undefined,
      NODEJS_HELPERS: undefined,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('STRIPE_WEBHOOK_SECRET is required');
  });

  test('aborts Vercel production startup unless NODEJS_HELPERS is exactly 0', () => {
    const result = importProductionApp({
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      VERCEL: '1',
      NODEJS_HELPERS: '1',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("NODEJS_HELPERS must be '0'");
  });

  test('allows production startup with valid Vercel webhook configuration', () => {
    const result = importProductionApp({
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STRIPE_WEBHOOK_TOLERANCE_SEC: '300',
      VERCEL: '1',
      NODEJS_HELPERS: '0',
    });

    expect(result.status).toBe(0);
  });
});

describe('verifyAndParse', () => {
  beforeEach(() => {
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_TOLERANCE_SEC;
  });

  test('accepts a valid signature over the exact raw Buffer', () => {
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });

    const event = verifyAndParse(Buffer.from(payload), signature);

    expect(event.id).toBe('evt_webhook_verifier_unit_test');
    expect(event.type).toBe('payment_intent.succeeded');
  });

  test('rejects a non-Buffer body as a pipeline error', () => {
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });

    expect(() => verifyAndParse(payload, signature)).toThrow(
      StripeWebhookPipelineError
    );
  });

  test('rejects a tampered payload as a verification error', () => {
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });

    expect(() =>
      verifyAndParse(Buffer.from(`${payload} `), signature)
    ).toThrow(StripeWebhookVerificationError);
  });

  test('rejects signed malformed JSON as a verification error', () => {
    const malformedPayload = '{"id":"evt_invalid_json"';
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: malformedPayload,
      secret: WEBHOOK_SECRET,
    });

    expect(() =>
      verifyAndParse(Buffer.from(malformedPayload), signature)
    ).toThrow(StripeWebhookVerificationError);
  });

  test('rejects a timestamp older than the configured tolerance', () => {
    process.env.STRIPE_WEBHOOK_TOLERANCE_SEC = '300';
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
      timestamp: Math.floor(Date.now() / 1000) - 600,
    });

    expect(() => verifyAndParse(Buffer.from(payload), signature)).toThrow(
      StripeWebhookVerificationError
    );
  });

  test('fails closed without a signing secret outside production too', () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;

    expect(() => verifyAndParse(Buffer.from(payload), 'missing')).toThrow(
      StripeWebhookConfigError
    );
  });
});
