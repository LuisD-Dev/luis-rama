import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../app.js';
import prisma from '../utils/prismaClient.js';
import { setupTestDb } from './helpers/db.setup.js';

setupTestDb();

describe('simulated Payment intent routes', () => {
  let admin;
  let adminToken;
  let student;
  let studentToken;
  let sequence = 0;

  const tokenFor = (user) =>
    jwt.sign(
      {
        id: user.id,
        role: user.role,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      process.env.JWT_SECRET
    );

  const createPayment = (status, planTier = 'pro') => {
    sequence += 1;
    return prisma.payment.create({
      data: {
        userId: student.id,
        amount: 2499,
        currency: 'usd',
        planTier,
        status,
        provider: 'simulated',
        idempotencyKey: `simulated-confirm-${status}-${sequence}`,
      },
    });
  };

  const confirm = (paymentId) =>
    request(app)
      .post(`/api/payments/intent/${paymentId}/confirm`)
      .set('Authorization', `Bearer ${adminToken}`);

  beforeEach(async () => {
    process.env.JWT_SECRET ||= 'phase3b1_test_jwt_secret';
    sequence = 0;
    student = await prisma.user.create({
      data: {
        email: `phase3b1-student-${Date.now()}@example.com`,
        passwordHash: 'hashed-password',
        name: 'Phase 3B-1 Student',
        role: 'student',
      },
    });
    admin = await prisma.user.create({
      data: {
        email: `phase3b1-admin-${Date.now()}@example.com`,
        passwordHash: 'hashed-password',
        name: 'Phase 3B-1 Admin',
        role: 'admin',
      },
    });
    studentToken = tokenFor(student);
    adminToken = tokenFor(admin);
  });

  test('POST /api/payments/intent creates and returns a pending Payment', async () => {
    const response = await request(app)
      .post('/api/payments/intent')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ plan_tier: 'pro' });

    expect(response.statusCode).toBe(201);
    expect(response.body).toMatchObject({
      status: 'pending',
      plan_tier: 'pro',
      amount: 2499,
    });
    expect(response.body.paymentId).toEqual(expect.any(Number));

    const stored = await prisma.payment.findUnique({
      where: { id: response.body.paymentId },
    });
    expect(stored).toMatchObject({
      status: 'pending',
      provider: 'simulated',
      userId: student.id,
    });
  });

  test('confirms pending through processing to succeeded and activates entitlement', async () => {
    const payment = await createPayment('pending');

    const response = await confirm(payment.id);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      paymentId: payment.id,
      status: 'succeeded',
      plan_tier: 'pro',
      amount: 2499,
    });
    const stored = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(stored.status).toBe('succeeded');
    const updatedUser = await prisma.user.findUnique({ where: { id: student.id } });
    expect(updatedUser).toMatchObject({ planTier: 'pro', role: 'premium' });
  });

  test('confirms an existing processing Payment to succeeded', async () => {
    const payment = await createPayment('processing', 'master');

    const response = await confirm(payment.id);

    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('succeeded');
    const updatedUser = await prisma.user.findUnique({ where: { id: student.id } });
    expect(updatedUser).toMatchObject({ planTier: 'master', role: 'premium' });
  });

  test('normalizes a created Payment through the complete canonical chain', async () => {
    const payment = await createPayment('created', 'basico');

    const response = await confirm(payment.id);

    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('succeeded');
    const stored = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(stored.status).toBe('succeeded');
    const updatedUser = await prisma.user.findUnique({ where: { id: student.id } });
    expect(updatedUser).toMatchObject({ planTier: 'basico', role: 'premium' });
  });

  test.each([
    { status: 'succeeded', label: 'canonical success' },
    { status: 'failed', label: 'failure' },
    { status: 'canceled', label: 'cancellation' },
    { status: 'completed', label: 'legacy completed success' },
    { status: 'processed', label: 'legacy processed success' },
  ])('returns 409 without entitlement for $label', async ({ status }) => {
    await prisma.user.update({
      where: { id: student.id },
      data: { planTier: 'basico', role: 'student' },
    });
    const payment = await createPayment(status, 'pro');

    const response = await confirm(payment.id);

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: 'payment_already_processed',
      currentStatus: status,
    });
    const stored = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(stored.status).toBe(status);
    const unchangedUser = await prisma.user.findUnique({ where: { id: student.id } });
    expect(unchangedUser).toMatchObject({ planTier: 'basico', role: 'student' });
  });

  test('a repeated confirmation returns 409 and does not reapply entitlement', async () => {
    const payment = await createPayment('pending', 'master');
    const first = await confirm(payment.id);
    expect(first.statusCode).toBe(200);

    await prisma.user.update({
      where: { id: student.id },
      data: { planTier: null, role: 'student' },
    });
    const second = await confirm(payment.id);

    expect(second.statusCode).toBe(409);
    expect(second.body.currentStatus).toBe('succeeded');
    const unchangedUser = await prisma.user.findUnique({ where: { id: student.id } });
    expect(unchangedUser).toMatchObject({ planTier: null, role: 'student' });
  });
});
