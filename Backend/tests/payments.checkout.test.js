import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../app.js';
import { setupTestDb } from './helpers/db.setup.js';
import prisma from '../utils/prismaClient.js';

setupTestDb();

describe('POST /api/payments/checkout', () => {
  let authToken;
  let testUserId;
  let previousEnv;

  beforeEach(async () => {
    if (!process.env.JWT_SECRET) {
      process.env.JWT_SECRET = 'test_jwt_secret';
    }

    previousEnv = {
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
      STRIPE_PRICE_BASICO: process.env.STRIPE_PRICE_BASICO,
      STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO,
      STRIPE_PRICE_MASTER: process.env.STRIPE_PRICE_MASTER,
      STRIPE_CHECKOUT_SUCCESS_URL: process.env.STRIPE_CHECKOUT_SUCCESS_URL,
      STRIPE_CHECKOUT_CANCEL_URL: process.env.STRIPE_CHECKOUT_CANCEL_URL,
      NODE_ENV: process.env.NODE_ENV,
    };

    // Success path uses the no-secret test stub
    delete process.env.STRIPE_SECRET_KEY;
    process.env.NODE_ENV = 'test';
    process.env.STRIPE_PRICE_BASICO = 'price_test_basico';
    process.env.STRIPE_PRICE_PRO = 'price_test_pro';
    process.env.STRIPE_PRICE_MASTER = 'price_test_master';
    process.env.STRIPE_CHECKOUT_SUCCESS_URL =
      'http://localhost:5173/dashboard?checkout=success&session_id={CHECKOUT_SESSION_ID}';
    process.env.STRIPE_CHECKOUT_CANCEL_URL = 'http://localhost:5173/?checkout=cancelled';

    const user = await prisma.user.create({
      data: {
        email: `test-checkout-${Date.now()}@example.com`,
        passwordHash: 'hashed-password',
        name: 'Checkout User',
      },
    });
    testUserId = user.id;
    authToken = jwt.sign(
      {
        id: user.id,
        role: user.role,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      process.env.JWT_SECRET
    );
  });

  afterEach(async () => {
    await prisma.paymentEvent.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.user.deleteMany({ where: { id: testUserId } });

    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('returns 401 without JWT', async () => {
    const res = await request(app)
      .post('/api/payments/checkout')
      .send({ plan: 'basico' });

    expect(res.statusCode).toBe(401);
  });

  test('returns 400 when plan is missing', async () => {
    const res = await request(app)
      .post('/api/payments/checkout')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.fields?.plan).toMatch(/plan must be one of/i);
  });

  test('returns 400 when plan is invalid', async () => {
    const res = await request(app)
      .post('/api/payments/checkout')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ plan: 'enterprise' });

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.fields?.plan).toMatch(/plan must be one of/i);
  });

  test('creates Checkout Session stub and pending Payment', async () => {
    const res = await request(app)
      .post('/api/payments/checkout')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ plan: 'pro' });

    expect(res.statusCode).toBe(200);
    expect(res.body.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(res.body.sessionId).toMatch(/^cs_test_/);
    expect(res.body).not.toHaveProperty('stripeError');

    const payment = await prisma.payment.findFirst({
      where: { userId: testUserId, planTier: 'pro' },
    });
    expect(payment).not.toBeNull();
    expect(payment.status).toBe('pending');
    expect(payment.stripeCheckoutSessionId).toBe(res.body.sessionId);
    expect(payment.amount).toBe(2499);
  });

  test('Stripe API failure returns safe client message and marks Payment failed', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_force_error';

    const res = await request(app)
      .post('/api/payments/checkout')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ plan: 'basico' });

    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'Unable to start checkout. Please try again.' });
    expect(JSON.stringify(res.body)).not.toMatch(/Simulated Stripe/i);

    const payment = await prisma.payment.findFirst({
      where: { userId: testUserId, planTier: 'basico' },
    });
    expect(payment).not.toBeNull();
    expect(payment.status).toBe('failed');
  });
});
