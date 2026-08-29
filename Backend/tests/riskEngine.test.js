import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../app.js';
import prisma from '../utils/prismaClient.js';
import { setupTestDb } from './helpers/db.setup.js';
import { evaluate, getThresholds } from '../services/riskEngine.js';

setupTestDb();

describe('riskEngine pure evaluate', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in originalEnv)) delete process.env[k];
    for (const [k,v] of Object.entries(originalEnv)) process.env[k]=v;
  });

  test('allow when no signals', () => {
    const r = evaluate({ attemptsUserHour: 0, distinctPMsUserDay: 0, failsIpHour: 0, accountAgeMinutes: 60, planTier: 'basico' });
    expect(r.decision).toBe('allow');
    expect(r.score).toBe(0);
  });

  test('challenge on 8 attempts / user / hour', () => {
    const r = evaluate({ attemptsUserHour: 8, distinctPMsUserDay: 0, failsIpHour: 0, accountAgeMinutes: 60, planTier: 'pro' });
    expect(r.decision).toBe('challenge');
  });

  test('block on 4 distinct PMs / user / day', () => {
    const r = evaluate({ distinctPMsUserDay: 4, failsIpHour: 0, attemptsUserHour: 0, accountAgeMinutes: 60, planTier: 'pro' });
    expect(r.decision).toBe('block');
  });

  test('block on 12 fails / IP / hour', () => {
    const r = evaluate({ failsIpHour: 12, attemptsUserHour: 0, distinctPMsUserDay: 0, accountAgeMinutes: 60, planTier: 'basico' });
    expect(r.decision).toBe('block');
  });

  test('challenge new account (<30m) + master tier', () => {
    const r = evaluate({ accountAgeMinutes: 10, planTier: 'master', attemptsUserHour: 0, distinctPMsUserDay: 0, failsIpHour: 0 });
    expect(r.decision).toBe('challenge');
  });

  test('whitelisted bypasses', () => {
    const r = evaluate({ attemptsUserHour: 99, distinctPMsUserDay: 99, failsIpHour: 99, accountAgeMinutes: 1, planTier: 'master', isWhitelisted: true });
    expect(r.decision).toBe('allow');
  });

  test('thresholds configurable', () => {
    process.env.RISK_THRESHOLD_ATTEMPTS_USER_HOUR = '2';
    const r = evaluate({ attemptsUserHour: 2, distinctPMsUserDay: 0, failsIpHour: 0, accountAgeMinutes: 60, planTier: 'basico' });
    expect(r.decision).toBe('challenge');
  });

  test('block overrides challenge', () => {
    const r = evaluate({ attemptsUserHour: 8, distinctPMsUserDay: 4, accountAgeMinutes: 5, planTier: 'master', failsIpHour: 0 });
    expect(r.decision).toBe('block');
  });
});

describe('risk guard integration', () => {
  let userId;
  let token;
  let adminToken;
  let adminId;

  beforeEach(async () => {
    const user = await prisma.user.create({ data: { email: `risk-${Date.now()}-${Math.random()}@example.com`, passwordHash: 'x', name: 'Risk User' } });
    userId = user.id;
    token = jwt.sign({ id: userId, role: 'student', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 }, process.env.JWT_SECRET);
    const admin = await prisma.user.create({ data: { email: `admin-risk-${Date.now()}@example.com`, passwordHash: 'x', name: 'Admin', role: 'admin' } });
    adminId = admin.id;
    adminToken = jwt.sign({ id: adminId, role: 'admin', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600 }, process.env.JWT_SECRET);
    process.env.RISK_ENGINE_MODE = 'shadow';
  });

  afterEach(async () => {
    await prisma.riskDecision.deleteMany({});
    await prisma.payment.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.user.deleteMany({ where: { id: adminId } });
    delete process.env.RISK_ENGINE_MODE;
    delete process.env.RISK_THRESHOLD_ATTEMPTS_USER_HOUR;
  });

  test('shadow mode default allows and audits', async () => {
    process.env.RISK_ENGINE_MODE = 'shadow';
    // Create 8 prior payments to trigger challenge threshold but shadow should still allow
    for (let i=0;i<8;i++) {
      await prisma.payment.create({ data: { userId, amount: 999, currency: 'usd', planTier: 'basico', provider: 'stripe', idempotencyKey: `shadow-${Date.now()}-${i}-${Math.random()}`, status: 'pending' } });
    }
    const res = await request(app).post('/api/payments/payment-method')
      .set('Authorization', `Bearer ${token}`)
      .send({ paymentMethodId: 'pm_shadow_1', planTier: 'basico', idempotencyKey: `shadow-new-${Date.now()}` });
    // shadow should allow (200) even though attempts >=8
    expect([200,201]).toContain(res.statusCode);
    const decisions = await prisma.riskDecision.findMany({ where: { userId } });
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions[0].mode).toBe('shadow');
  });

  test('enforce mode blocks scripted burst fixture (8 attempts)', async () => {
    process.env.RISK_ENGINE_MODE = 'enforce';
    for (let i=0;i<8;i++) {
      await prisma.payment.create({ data: { userId, amount: 999, currency: 'usd', planTier: 'basico', provider: 'stripe', idempotencyKey: `enforce-${Date.now()}-${i}-${Math.random()}`, status: 'pending' } });
    }
    const res = await request(app).post('/api/payments/payment-method')
      .set('Authorization', `Bearer ${token}`)
      .send({ paymentMethodId: 'pm_burst', planTier: 'basico', idempotencyKey: `burst-${Date.now()}` });
    expect(res.statusCode).toBe(423);
    expect(res.body.code).toBe('RISK_CHALLENGE');
    const decisions = await prisma.riskDecision.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
    expect(decisions[0].decision).toBe('challenge');
  });

  test('enforce blocks 4 distinct PMs', async () => {
    process.env.RISK_ENGINE_MODE = 'enforce';
    for (let i=0;i<3;i++) {
      await prisma.payment.create({ data: { userId, amount: 999, currency: 'usd', planTier: 'pro', provider: 'stripe', paymentMethodId: `pm_${i}`, idempotencyKey: `pm-distinct-${Date.now()}-${i}`, status: 'pending' } });
    }
    const res = await request(app).post('/api/payments/payment-method')
      .set('Authorization', `Bearer ${token}`)
      .send({ paymentMethodId: 'pm_3_new', planTier: 'pro', idempotencyKey: `pm-new-${Date.now()}` });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('RISK_BLOCK');
  });

  test('new account master challenge', async () => {
    process.env.RISK_ENGINE_MODE = 'enforce';
    // user was just created (<30m ago)
    const res = await request(app).post('/api/payments/payment-method')
      .set('Authorization', `Bearer ${token}`)
      .send({ paymentMethodId: 'pm_new_master', planTier: 'master', idempotencyKey: `master-${Date.now()}` });
    expect(res.statusCode).toBe(423);
  });

  test('enforce blocks after 12 failed payments per IP', async () => {
    process.env.RISK_ENGINE_MODE = 'enforce';
    const { hashIp } = await import('../services/riskEngine.js');
    const ipHashes = [hashIp('127.0.0.1'), hashIp('::ffff:127.0.0.1'), hashIp('::1')];
    // create 12 failed payments for each possible hash to ensure count hits threshold
    for (const h of ipHashes) {
      for (let i = 0; i < 12; i++) {
        await prisma.payment.create({
          data: {
            userId,
            amount: 999,
            currency: 'usd',
            planTier: 'basico',
            provider: 'stripe',
            idempotencyKey: `fail-ip-${h}-${i}-${Date.now()}-${Math.random()}`,
            status: 'failed',
            ipHash: h,
          },
        });
      }
    }
    const res = await request(app).post('/api/payments/payment-method')
      .set('Authorization', `Bearer ${token}`)
      .send({ paymentMethodId: 'pm_ip_fail', planTier: 'basico', idempotencyKey: `ip-fail-${Date.now()}` });
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('RISK_BLOCK');
    // verify DB threshold counted — block due to failsIpHour
    const decisions = await prisma.riskDecision.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
    expect(decisions[0].decision).toBe('block');
    const signals = JSON.parse(decisions[0].signalsJson);
    expect(signals.failsIpHour).toBeGreaterThanOrEqual(12);
  });

  test('idempotent replay still records decision but skips double-charge', async () => {
    process.env.RISK_ENGINE_MODE = 'shadow';
    const key = `replay-${Date.now()}`;
    const first = await request(app).post('/api/payments/payment-method')
      .set('Authorization', `Bearer ${token}`)
      .send({ paymentMethodId: 'pm_replay', planTier: 'basico', idempotencyKey: key });
    expect([200,201]).toContain(first.statusCode);
    const paymentId = first.body.paymentId;
    const second = await request(app).post('/api/payments/payment-method')
      .set('Authorization', `Bearer ${token}`)
      .send({ paymentMethodId: 'pm_replay', planTier: 'basico', idempotencyKey: key });
    expect(second.body.paymentId).toBe(paymentId);
    expect(second.body.replay).toBe(true);
    const decisions = await prisma.riskDecision.findMany({ where: { userId } });
    expect(decisions.length).toBe(2);
  });

  test('admin read API returns recent blocks/challenges', async () => {
    process.env.RISK_ENGINE_MODE = 'shadow';
    for (let i=0;i<8;i++) {
      await prisma.payment.create({ data: { userId, amount: 999, currency: 'usd', planTier: 'basico', provider: 'stripe', idempotencyKey: `admin-read-${Date.now()}-${i}`, status: 'pending' } });
    }
    await request(app).post('/api/payments/payment-method')
      .set('Authorization', `Bearer ${token}`)
      .send({ paymentMethodId: 'pm_admin_read', planTier: 'basico', idempotencyKey: `admin-read-new-${Date.now()}` });
    const res = await request(app).get('/api/payments/risk/decisions')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.decisions)).toBe(true);
  });

  test('whitelist bypasses risk', async () => {
    process.env.RISK_ENGINE_MODE = 'enforce';
    // make user whitelisted via admin endpoint
    await request(app).post(`/api/payments/risk/whitelist/${userId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ whitelisted: true });
    // Create burst that would normally block
    for (let i=0;i<8;i++) {
      await prisma.payment.create({ data: { userId, amount: 999, currency: 'usd', planTier: 'basico', provider: 'stripe', idempotencyKey: `whitelist-burst-${Date.now()}-${i}`, status: 'pending' } });
    }
    const res = await request(app).post('/api/payments/payment-method')
      .set('Authorization', `Bearer ${token}`)
      .send({ paymentMethodId: 'pm_whitelist', planTier: 'basico', idempotencyKey: `whitelist-${Date.now()}` });
    expect([200,201]).toContain(res.statusCode);
  });

  test('payments happy path still works under shadow', async () => {
    process.env.RISK_ENGINE_MODE = 'shadow';
    const res = await request(app).post('/api/payments/payment-method')
      .set('Authorization', `Bearer ${token}`)
      .send({ paymentMethodId: 'pm_happy', planTier: 'basico', idempotencyKey: `happy-${Date.now()}` });
    expect([200,201]).toContain(res.statusCode);
    expect(res.body.paymentId).toBeDefined();
    expect(res.body.status).toBe('pending');
  });
});
