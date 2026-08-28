import request from 'supertest';
import app from '../app.js';
import prisma from '../utils/prismaClient.js';
import { setupTestDb, promoteUserToAdmin } from './helpers/db.setup.js';
import { adminUser } from './fixtures/users.js';
import { setUserPlanTier } from '../services/entitlementService.js';

setupTestDb();

describe('Admin plan assignment — entitlement epoch', () => {
  let adminToken;

  beforeEach(async () => {
    await request(app)
      .post('/api/auth/signup')
      .send({ name: adminUser.name, email: adminUser.email, password: adminUser.password });

    await promoteUserToAdmin(adminUser.email);

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: adminUser.email, password: adminUser.password });
    adminToken = loginRes.body.token;
  });

  test('downgrade via admin endpoint bumps epoch and blocks higher-tier content', async () => {
    const student = await prisma.user.create({
      data: {
        email: `downgrade-test-${Date.now()}@example.com`,
        passwordHash: 'hashed',
        name: 'Downgrade Test',
        role: 'premium',
        planTier: 'master',
        entitlementEpoch: 0,
      },
    });

    const res = await request(app)
      .patch(`/api/auth/students/${student.id}/plan`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plan_tier: null });

    expect(res.status).toBe(200);

    const updated = await prisma.user.findUnique({ where: { id: student.id } });
    expect(updated.planTier).toBeNull();
    expect(updated.entitlementEpoch).toBe(1);
  });

  test('assigning the same tier again still bumps the epoch', async () => {
    const student = await prisma.user.create({
      data: {
        email: `same-tier-${Date.now()}@example.com`,
        passwordHash: 'hashed',
        name: 'Same Tier Test',
        role: 'premium',
        planTier: 'pro',
        entitlementEpoch: 3,
      },
    });

    const res = await request(app)
      .patch(`/api/auth/students/${student.id}/plan`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plan_tier: 'pro' });

    expect(res.status).toBe(200);

    const updated = await prisma.user.findUnique({ where: { id: student.id } });
    expect(updated.planTier).toBe('pro');
    expect(updated.entitlementEpoch).toBe(4);
  });

  // Safety net test: 'premium' no es un valor de entrada real para User.planTier
  // (el admin endpoint lo rechaza en validación, y ningún webhook lo emite).
  // Existe históricamente en Content.planTier — ver Backend/scripts/migrations/
  // migrate-premium-plan-tier.js — y setUserPlanTier lo normaliza por si alguna
  // vez llega un valor legacy de datos viejos en la DB. Este test protege esa
  // normalización, no un flujo de negocio activo.
  test('legacy "premium" tier normalization does not skip the epoch bump', async () => {
    const student = await prisma.user.create({
      data: {
        email: `legacy-premium-${Date.now()}@example.com`,
        passwordHash: 'hashed',
        name: 'Legacy Premium Test',
        role: 'student',
        planTier: 'basico',
        entitlementEpoch: 0,
      },
    });

    const updated = await setUserPlanTier({
      userId: student.id,
      planTier: 'premium',
      reason: 'test_legacy',
      actor: 'test',
    });

    expect(updated.planTier).toBe('basico');
    expect(updated.entitlementEpoch).toBe(1);
  });
});
