import request from 'supertest';
import app from '../app.js';
import { setupTestDb, promoteUserToAdmin } from './helpers/db.setup.js';
import { normalUser, adminUser } from './fixtures/users.js';
import prisma from '../utils/prismaClient.js';
import localProvider from '../storage/localProvider.js';

setupTestDb();

describe('Content endpoints', () => {
  let adminToken;

  beforeAll(async () => {
    // app is statically imported so available here
  });

  beforeEach(async () => {
    // create an admin account in DB directly by signing up and promoting
    await request(app).post('/api/auth/signup').send({ name: adminUser.name, email: adminUser.email, password: adminUser.password });

    // escalate to admin by updating DB before login so token reflects admin role
    await promoteUserToAdmin(adminUser.email);

    const loginRes = await request(app).post('/api/auth/login').send({ email: adminUser.email, password: adminUser.password });
    adminToken = loginRes.body.token;
  });

  it('GET /api/content should return array (200)', async () => {
    const res = await request(app).get('/api/content');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('content');
    expect(Array.isArray(res.body.content)).toBe(true);
  });

  it('Admin can upload content via POST /api/content/upload', async () => {
    let storagePath;
    try {
      const res = await request(app)
        .post('/api/content/upload')
        .set('Authorization', `Bearer ${adminToken}`)
        .field('title', 'Test lesson')
        .field('type', 'article')
        .field('description', 'A valid lesson description')
        .attach('file', Buffer.from('test pdf contents'), {
          filename: 'lesson.pdf',
          contentType: 'application/pdf',
        });

      // controller returns 200 with content
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('content');
      expect(res.body.content).toHaveProperty('title', 'Test lesson');
      storagePath = new URL(res.body.content.url, 'http://localhost').searchParams.get('path');
    } finally {
      if (storagePath) await localProvider.delete(storagePath);
    }
  });

  it('Non-admin cannot upload content', async () => {
    // create normal user and login
    await request(app).post('/api/auth/signup').send(normalUser);
    const r = await request(app).post('/api/auth/login').send({ email: normalUser.email, password: normalUser.password });
    const token = r.body.token;

    const res = await request(app)
      .post('/api/content/upload')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Forbidden upload', type: 'article', description: 'Not allowed to upload' });

    expect(res.status).toBe(403);
  });

  it('GET /api/content/:id returns 404 for missing id', async () => {
    const res = await request(app).get('/api/content/99999');
    expect([404,400]).toContain(res.status);
  });

  it('keeps free content available without authentication', async () => {
    const uploader = await prisma.user.findFirst({ where: { email: adminUser.email } });
    const storagePath = await localProvider.upload({
      buffer: Buffer.from('public lesson'),
      originalname: 'free-lesson.pdf',
      mimetype: 'application/pdf',
      size: 13,
    }, 'content');

    try {
      await prisma.content.create({
        data: {
          title: 'Free local lesson',
          description: 'A public lesson for everyone',
          type: 'article',
          url: storagePath,
          isFree: 1,
          planTier: 'free',
          uploadedBy: uploader.id,
        },
      });

      const res = await request(app).get('/api/content/free');

      expect(res.status).toBe(200);
      expect(res.body.content).toHaveLength(1);
      expect(res.body.content[0].url).toMatch(/^\/api\/media\/public\?/);

      const mediaResponse = await request(app).get(res.body.content[0].url);
      expect(mediaResponse.status).toBe(200);
      expect(mediaResponse.body.toString()).toBe('public lesson');
    } finally {
      await localProvider.delete(storagePath);
    }
  });

  it('does not expose master content or its storage path to a basico user', async () => {
    await request(app).post('/api/auth/signup').send(normalUser);
    await prisma.user.update({
      where: { email: normalUser.email },
      data: { planTier: 'basico', role: 'premium' },
    });
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: normalUser.email, password: normalUser.password });
    const uploader = await prisma.user.findFirst({ where: { email: adminUser.email } });
    await prisma.content.create({
      data: {
        title: 'Master-only lesson',
        description: 'Restricted master content',
        type: 'article',
        url: 'content/master-secret.pdf',
        isFree: 0,
        planTier: 'master',
        uploadedBy: uploader.id,
      },
    });

    const res = await request(app)
      .get('/api/content')
      .set('Authorization', `Bearer ${login.body.token}`);

    expect(res.status).toBe(200);
    expect(res.body.content).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('master-secret.pdf');
  });

  it('returns 404 when paid content is explicitly requested from the free endpoint', async () => {
    const uploader = await prisma.user.findFirst({ where: { email: adminUser.email } });
    const paidContent = await prisma.content.create({
      data: {
        title: 'Paid content with inconsistent legacy flag',
        description: 'This must remain private despite its legacy flag',
        type: 'article',
        url: 'content/paid-explicit-request.pdf',
        isFree: 1,
        planTier: 'master',
        uploadedBy: uploader.id,
      },
    });

    const byId = await request(app).get(`/api/content/free?id=${paidContent.id}`);
    const byPath = await request(app)
      .get('/api/content/free')
      .query({ path: paidContent.url });
    const directPublicMedia = await request(app)
      .get('/api/media/public')
      .query({ path: paidContent.url });

    expect(byId.status).toBe(404);
    expect(byPath.status).toBe(404);
    expect(directPublicMedia.status).toBe(404);
    expect(JSON.stringify(byId.body)).not.toContain(paidContent.url);
  });

  it('treats a legacy row with no plan and no free flag as paid', async () => {
    const uploader = await prisma.user.findFirst({ where: { email: adminUser.email } });
    const ambiguousContent = await prisma.content.create({
      data: {
        title: 'Ambiguous legacy content',
        description: 'Missing plan must fail closed',
        type: 'article',
        url: 'content/ambiguous-legacy.pdf',
        isFree: 0,
        planTier: null,
        uploadedBy: uploader.id,
      },
    });

    const freeResponse = await request(app)
      .get(`/api/content/free?id=${ambiguousContent.id}`);
    const anonymousList = await request(app).get('/api/content');

    expect(freeResponse.status).toBe(404);
    expect(anonymousList.status).toBe(200);
    expect(JSON.stringify(anonymousList.body)).not.toContain(ambiguousContent.url);
  });

  it('returns a signed paid-content URL to an admin', async () => {
    const uploader = await prisma.user.findFirst({ where: { email: adminUser.email } });
    await prisma.content.create({
      data: {
        title: 'Admin paid lesson',
        description: 'Restricted lesson available to admins',
        type: 'article',
        url: 'content/admin-paid.pdf',
        isFree: 0,
        planTier: 'master',
        uploadedBy: uploader.id,
      },
    });

    const res = await request(app)
      .get('/api/content')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.content).toHaveLength(1);
    expect(res.body.content[0].url).toMatch(/^\/api\/media\/signed\?/);
    expect(res.body.content[0].url).toContain('exp=');
    expect(res.body.content[0].url).toContain('sig=');
  });
});
