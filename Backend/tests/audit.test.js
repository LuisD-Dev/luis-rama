import request from 'supertest';
import app from '../app.js';
import prisma from '../utils/prismaClient.js';
import { setupTestDb, promoteUserToAdmin } from './helpers/db.setup.js';

setupTestDb();

const createUserAndLogin = async (user, makeAdmin = false) => {
  await request(app).post('/api/auth/signup').send(user);
  if (makeAdmin) await promoteUserToAdmin(user.email);
  const response = await request(app).post('/api/auth/login').send({ email: user.email, password: user.password });
  return response.body.token;
};

describe('Admin audit log', () => {
  it('audits plan assignment and preserves the request ID', async () => {
    const adminToken = await createUserAndLogin({ name: 'Audit Admin', email: 'audit-admin@example.com', password: 'AuditAdmin123!' }, true);
    const studentToken = await createUserAndLogin({ name: 'Audit Student', email: 'audit-student@example.com', password: 'AuditStudent123!' });
    const student = await prisma.user.findUnique({ where: { email: 'audit-student@example.com' } });

    const mutation = await request(app)
      .patch(`/api/auth/students/${student.id}/plan`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Request-Id', 'audit-request-123')
      .send({ plan_tier: 'pro' });

    expect(mutation.status).toBe(200);
    expect(mutation.headers['x-request-id']).toBe('audit-request-123');
    const audit = await request(app).get('/api/admin/audit').set('Authorization', `Bearer ${adminToken}`);
    expect(audit.status).toBe(200);
    expect(audit.body.events).toHaveLength(1);
    expect(audit.body.events[0]).toMatchObject({ action: 'plan.assign', requestId: 'audit-request-123' });
    expect(studentToken).toBeTruthy();
  });

  it('rejects non-admin audit reads and detects payload tampering', async () => {
    const adminToken = await createUserAndLogin({ name: 'Audit Admin 2', email: 'audit-admin-2@example.com', password: 'AuditAdmin123!' }, true);
    const studentToken = await createUserAndLogin({ name: 'Audit Student 2', email: 'audit-student-2@example.com', password: 'AuditStudent123!' });
    expect((await request(app).get('/api/admin/audit').set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);

    await prisma.adminAuditEvent.create({
      data: {
        actorUserId: 1, action: 'test', targetType: 'test', targetId: '1', prevHash: '0'.repeat(64), entryHash: 'tampered-entry',
        afterJson: '{"value":"original"}',
      },
    });
    await prisma.adminAuditEvent.updateMany({ where: { entryHash: 'tampered-entry' }, data: { afterJson: '{"value":"changed"}' } });
    const verification = await request(app).get('/api/admin/audit/verify').set('Authorization', `Bearer ${adminToken}`);
    expect(verification.status).toBe(500);
    expect(verification.body.valid).toBe(false);
  });
});