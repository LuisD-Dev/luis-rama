import request from 'supertest';
import app from '../app.js';
import { setupTestDb, promoteUserToAdmin } from './helpers/db.setup.js';
import { adminUser } from './fixtures/users.js';
import prisma from '../utils/prismaClient.js';

setupTestDb();

describe('Stats endpoints', () => {

  it('POST /api/stats/visit should increase counter and return 200', async () => {
    const res = await request(app).post('/api/stats/visit');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total');
    expect(typeof res.body.total).toBe('number');
  });

  it('GET /api/stats/visits should be forbidden for non-admin and allowed for admin', async () => {
    // non-admin
    const r1 = await request(app).get('/api/stats/visits');
    expect([401,403]).toContain(r1.status);

    // create admin and promote before login
    await request(app).post('/api/auth/signup').send({ name: adminUser.name, email: adminUser.email, password: adminUser.password });
    await promoteUserToAdmin(adminUser.email);
    const login = await request(app).post('/api/auth/login').send({ email: adminUser.email, password: adminUser.password });
    const token = login.body.token;

    const r2 = await request(app).get('/api/stats/visits').set('Authorization', `Bearer ${token}`);
    expect(r2.status).toBe(200);
    expect(r2.body).toHaveProperty('pageVisits');
    expect(r2.body).toHaveProperty('studentCount');
  });

  it('GET /api/admin/stats counts canonical and legacy success statuses only', async () => {
    await request(app).post('/api/auth/signup').send({ name: adminUser.name, email: adminUser.email, password: adminUser.password });
    await promoteUserToAdmin(adminUser.email);
    const loginAdmin = await request(app).post('/api/auth/login').send({ email: adminUser.email, password: adminUser.password });
    const adminToken = loginAdmin.body.token;

    const users = await Promise.all(
      [
        'succeeded',
        'completed',
        'processed',
        'pending',
        'processing',
        'failed',
        'canceled',
      ].map((status) =>
        prisma.user.create({
          data: {
            name: `${status} Student`,
            email: `${status}.stats@example.com`,
            passwordHash: 'hashed-password',
          },
        })
      )
    );
    const userByStatus = Object.fromEntries(
      users.map((user) => [user.name.split(' ')[0], user])
    );

    const now = new Date();
    const firstDayCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 5, 12, 0, 0);
    const firstDayLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 5, 12, 0, 0);

    const fixtures = [
      { status: 'succeeded', amount: 120, planTier: 'basico', createdAt: firstDayCurrentMonth },
      { status: 'completed', amount: 60, planTier: 'pro', createdAt: firstDayCurrentMonth },
      { status: 'processed', amount: 40, planTier: 'master', createdAt: firstDayLastMonth },
      { status: 'pending', amount: 200, planTier: 'basico', createdAt: firstDayCurrentMonth },
      { status: 'processing', amount: 300, planTier: 'pro', createdAt: firstDayCurrentMonth },
      { status: 'failed', amount: 400, planTier: 'master', createdAt: firstDayCurrentMonth },
      { status: 'canceled', amount: 500, planTier: 'master', createdAt: firstDayCurrentMonth },
    ];

    await Promise.all(
      fixtures.map((fixture) =>
        prisma.payment.create({
          data: {
            userId: userByStatus[fixture.status].id,
            amount: fixture.amount,
            status: fixture.status,
            planTier: fixture.planTier,
            idempotencyKey: `stats-${fixture.status}`,
            createdAt: fixture.createdAt,
          },
        })
      )
    );

    const res = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      revenueThisMonth: 180,
      revenueLastMonth: 40,
      revenueChange: 350,
      activeSubscriptions: {
        basico: 1,
        pro: 1,
        master: 1,
        total: 3,
      },
      currency: 'USD',
    });
  });

  it('GET /api/admin/stats should reject non-admin users', async () => {
    await request(app).post('/api/auth/signup').send({ name: 'Normal User', email: 'normal.user@example.com', password: 'Student*123' });
    const loginUser = await request(app).post('/api/auth/login').send({ email: 'normal.user@example.com', password: 'Student*123' });

    const res = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${loginUser.body.token}`);

    expect(res.status).toBe(403);
  });
});
