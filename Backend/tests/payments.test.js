import request from 'supertest';
import app from '../app.js';
import prisma from '../utils/prismaClient.js';
import { setupTestDb } from './helpers/db.setup.js';
import { normalUser, studentUserTwo } from './fixtures/users.js';

setupTestDb();

const signupAndLogin = async (user) => {
  await request(app).post('/api/auth/signup').send(user);
  const res = await request(app).post('/api/auth/login').send({ email: user.email, password: user.password });
  return res.body.token;
};

describe('Payments Checkout Contract', () => {
  describe('POST /api/payments/payment-method', () => {
    it('should return succeeded status with machine-readable code for valid plan', async () => {
      const token = await signupAndLogin(normalUser);
      const res = await request(app)
        .post('/api/payments/payment-method')
        .set('Authorization', `Bearer ${token}`)
        .send({ planTier: 'pro', paymentMethodId: 'pm_mock_123', idempotencyKey: `idem-${Date.now()}-${Math.random()}` });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status', 'succeeded');
      expect(res.body).toHaveProperty('code', 'PAYMENT_SUCCEEDED');
      expect(res.body).toHaveProperty('paymentId');
      expect(res.body).toHaveProperty('stripePaymentIntentId');
      expect(res.body).toHaveProperty('planTier', 'pro');
      expect(res.body).toHaveProperty('amount', 2499);
      expect(res.body).toHaveProperty('currency', 'usd');
    });

    it('should reject invalid planTier with allowlist', async () => {
      const token = await signupAndLogin(normalUser);
      const res = await request(app)
        .post('/api/payments/payment-method')
        .set('Authorization', `Bearer ${token}`)
        .send({ planTier: 'invalid_plan', paymentMethodId: 'pm_123', idempotencyKey: `idem-${Date.now()}` });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PLAN_TIER');
    });

    it('should reject admin users purchasing', async () => {
      const adminUser = { name: 'Admin Test', email: 'adminpay@teclia.dev', password: 'Admin1234!' };
      await request(app).post('/api/auth/signup').send(adminUser);
      // promote to admin via direct db
      await prisma.user.updateMany({ where: { email: { equals: adminUser.email.toLowerCase() } }, data: { role: 'admin' } });
      const loginRes = await request(app).post('/api/auth/login').send({ email: adminUser.email, password: adminUser.password });
      const adminToken = loginRes.body.token;
      const res = await request(app)
        .post('/api/payments/payment-method')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ planTier: 'basico', paymentMethodId: 'pm_123', idempotencyKey: `idem-admin-${Date.now()}` });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ADMIN_PURCHASE_FORBIDDEN');
    });

    it('should require idempotencyKey', async () => {
      const token = await signupAndLogin(normalUser);
      const res = await request(app)
        .post('/api/payments/payment-method')
        .set('Authorization', `Bearer ${token}`)
        .send({ planTier: 'basico', paymentMethodId: 'pm_123' });
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('code');
    });

    it('should return same payment for same idempotencyKey (idempotency)', async () => {
      const token = await signupAndLogin(normalUser);
      const key = `idem-same-${Date.now()}`;
      const first = await request(app)
        .post('/api/payments/payment-method')
        .set('Authorization', `Bearer ${token}`)
        .send({ planTier: 'basico', paymentMethodId: 'pm_123', idempotencyKey: key });
      const second = await request(app)
        .post('/api/payments/payment-method')
        .set('Authorization', `Bearer ${token}`)
        .send({ planTier: 'basico', paymentMethodId: 'pm_123', idempotencyKey: key });
      expect(first.body.paymentId).toBe(second.body.paymentId);
      expect(first.body.status).toBe(second.body.status);
    });

    it('should use server amount map, never trust client amount', async () => {
      const token = await signupAndLogin(normalUser);
      const res = await request(app)
        .post('/api/payments/payment-method')
        .set('Authorization', `Bearer ${token}`)
        .send({ planTier: 'master', paymentMethodId: 'pm_123', idempotencyKey: `idem-amount-${Date.now()}`, amount: 1 });
      expect(res.body.amount).toBe(4999); // master is 4999, not 1
    });

    it('should return processing for pending hint and pending/processing statuses are non-terminal', async () => {
      const token = await signupAndLogin(normalUser);
      const key = `pending-${Date.now()}-test`;
      const res = await request(app)
        .post('/api/payments/payment-method')
        .set('Authorization', `Bearer ${token}`)
        .send({ planTier: 'pro', paymentMethodId: 'pm_123', idempotencyKey: key });
      expect(res.status).toBe(200);
      expect(['pending', 'processing']).toContain(res.body.status);
      expect(res.body.code).toBe('PAYMENT_PROCESSING');
      // polling should still return same non-terminal
      const poll = await request(app)
        .get(`/api/payments/${res.body.paymentId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(['pending', 'processing']).toContain(poll.body.status);
    });

    it('should return failed for fail hint', async () => {
      const token = await signupAndLogin(normalUser);
      const key = `fail-${Date.now()}-test`;
      const res = await request(app)
        .post('/api/payments/payment-method')
        .set('Authorization', `Bearer ${token}`)
        .send({ planTier: 'basico', paymentMethodId: 'pm_123', idempotencyKey: key });
      expect(res.body.status).toBe('failed');
      expect(res.body.code).toBe('PAYMENT_FAILED');
      // user plan should not be upgraded on failure
      const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
      // plan_tier should still be null (no upgrade)
      expect(me.body.user.plan_tier).toBeFalsy();
    });

    it('should upgrade user planTier on succeeded payment', async () => {
      const token = await signupAndLogin(normalUser);
      const key = `succ-${Date.now()}`;
      await request(app)
        .post('/api/payments/payment-method')
        .set('Authorization', `Bearer ${token}`)
        .send({ planTier: 'master', paymentMethodId: 'pm_123', idempotencyKey: key });
      const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
      expect(me.body.user.plan_tier).toBe('master');
    });
  });

  describe('GET /api/payments/:id polling', () => {
    it('should require auth', async () => {
      const res = await request(app).get('/api/payments/1');
      expect(res.status).toBe(401);
    });

    it('should return payment for owner', async () => {
      const token = await signupAndLogin(normalUser);
      const post = await request(app)
        .post('/api/payments/payment-method')
        .set('Authorization', `Bearer ${token}`)
        .send({ planTier: 'basico', paymentMethodId: 'pm_123', idempotencyKey: `poll-owner-${Date.now()}` });
      const get = await request(app)
        .get(`/api/payments/${post.body.paymentId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(get.status).toBe(200);
      expect(get.body.paymentId).toBe(post.body.paymentId);
      expect(get.body).toHaveProperty('status');
      expect(get.body).toHaveProperty('code');
    });

    it('should not allow reading others payments (authz)', async () => {
      const tokenA = await signupAndLogin(normalUser);
      const tokenB = await signupAndLogin(studentUserTwo);
      const post = await request(app)
        .post('/api/payments/payment-method')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ planTier: 'basico', paymentMethodId: 'pm_123', idempotencyKey: `poll-other-${Date.now()}` });
      const get = await request(app)
        .get(`/api/payments/${post.body.paymentId}`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(get.status).toBe(403);
      expect(get.body.code).toBe('UNAUTHORIZED');
    });

    it('should return 404 for nonexistent payment', async () => {
      const token = await signupAndLogin(normalUser);
      const res = await request(app)
        .get('/api/payments/999999')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('PAYMENT_NOT_FOUND');
    });

    it('should keep pending status stable across polls until webhook confirms (no auto success)', async () => {
      const token = await signupAndLogin(normalUser);
      const key = `pending-stable-${Date.now()}`;
      const post = await request(app)
        .post('/api/payments/payment-method')
        .set('Authorization', `Bearer ${token}`)
        .send({ planTier: 'pro', paymentMethodId: 'pm_123', idempotencyKey: key });
      expect(['pending','processing']).toContain(post.body.status);
      for (let i=0;i<3;i++) {
        const poll = await request(app).get(`/api/payments/${post.body.paymentId}`).set('Authorization', `Bearer ${token}`);
        expect(['pending','processing']).toContain(poll.body.status);
      }
    });
  });

  describe('Idempotency key rotation after failure', () => {
    it('should require new idempotency key after terminal failure to retry', async () => {
      const token = await signupAndLogin(normalUser);
      const failKey = `fail-rotate-${Date.now()}`;
      const first = await request(app)
        .post('/api/payments/payment-method')
        .set('Authorization', `Bearer ${token}`)
        .send({ planTier: 'basico', paymentMethodId: 'pm_fail', idempotencyKey: failKey });
      expect(first.body.status).toBe('failed');

      // retry with same key should return same failed payment (idempotent)
      const retrySame = await request(app)
        .post('/api/payments/payment-method')
        .set('Authorization', `Bearer ${token}`)
        .send({ planTier: 'basico', paymentMethodId: 'pm_ok', idempotencyKey: failKey });
      expect(retrySame.body.paymentId).toBe(first.body.paymentId);
      expect(retrySame.body.status).toBe('failed');

      // retry with new key should create new payment and succeed
      const newKey = `succ-retry-${Date.now()}`;
      const retryNew = await request(app)
        .post('/api/payments/payment-method')
        .set('Authorization', `Bearer ${token}`)
        .send({ planTier: 'basico', paymentMethodId: 'pm_ok', idempotencyKey: newKey });
      expect(retryNew.body.paymentId).not.toBe(first.body.paymentId);
      expect(retryNew.body.status).toBe('succeeded');
    });
  });
});
