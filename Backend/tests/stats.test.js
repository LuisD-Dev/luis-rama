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

  it('GET /api/admin/stats should aggregate revenue from completed payments only', async () => {
    await request(app).post('/api/auth/signup').send({ name: adminUser.name, email: adminUser.email, password: adminUser.password });
    await promoteUserToAdmin(adminUser.email);
    const loginAdmin = await request(app).post('/api/auth/login').send({ email: adminUser.email, password: adminUser.password });
    const adminToken = loginAdmin.body.token;

    await request(app).post('/api/auth/signup').send({ name: 'Student One', email: 'student.one@example.com', password: 'Student*123' });
    await request(app).post('/api/auth/signup').send({ name: 'Student Two', email: 'student.two@example.com', password: 'Student*123' });
    await request(app).post('/api/auth/signup').send({ name: 'Student Three', email: 'student.three@example.com', password: 'Student*123' });

    const [studentOne, studentTwo, studentThree] = await Promise.all([
      prisma.user.findUnique({ where: { email: 'student.one@example.com' } }),
      prisma.user.findUnique({ where: { email: 'student.two@example.com' } }),
      prisma.user.findUnique({ where: { email: 'student.three@example.com' } }),
    ]);

    const now = new Date();
    const firstDayCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 5, 12, 0, 0);
    const firstDayLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 5, 12, 0, 0);

    await Promise.all([
      prisma.payment.create({
        data: {
          userId: studentOne.id,
          amount: 120,
          status: 'completed',
          planTier: 'basico',
          createdAt: firstDayCurrentMonth,
        },
      }),
      prisma.payment.create({
        data: {
          userId: studentTwo.id,
          amount: 60,
          status: 'completed',
          planTier: 'pro',
          createdAt: firstDayCurrentMonth,
        },
      }),
      prisma.payment.create({
        data: {
          userId: studentThree.id,
          amount: 40,
          status: 'completed',
          planTier: 'master',
          createdAt: firstDayLastMonth,
        },
      }),
      prisma.payment.create({
        data: {
          userId: studentTwo.id,
          amount: 200,
          status: 'pending',
          planTier: 'master',
          createdAt: firstDayCurrentMonth,
        },
      }),
    ]);

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
