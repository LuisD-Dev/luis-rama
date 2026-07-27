import request from 'supertest';
import { jest } from '@jest/globals';
import prisma from '../utils/prismaClient.js';
import { setupTestDb, promoteUserToAdmin } from './helpers/db.setup.js';
import { normalUser, adminUser } from './fixtures/users.js';

jest.unstable_mockModule('../storage/index.js', () => ({
  default: {
    upload: jest.fn(async () => 'mock-upload-path'),
    resolveUrl: jest.fn((storagePath) => `https://mock-storage.test/${storagePath}`),
    delete: jest.fn(async () => { }),
  },
}));

const { default: app } = await import('../app.js');

setupTestDb();

const validContent = {
  title: 'Valid upload content',
  description: 'This description is long enough for validation.',
  type: 'video',
};

const createUploadRequest = (token, payload, { withFile = true } = {}) => {
  const requestBuilder = request(app)
    .post('/api/content/upload')
    .set('Authorization', `Bearer ${token}`);

  if (!withFile) {
    return requestBuilder.send(payload);
  }

  let multipartRequest = requestBuilder
    .field('title', payload.title)
    .field('type', payload.type)
    .field('description', payload.description);

  if (payload.plan_tier !== undefined && payload.plan_tier !== null) {
    multipartRequest = multipartRequest.field('plan_tier', payload.plan_tier);
  }

  return multipartRequest.attach('file', Buffer.from('test upload content'), {
    filename: 'test-upload.mp4',
    contentType: 'video/mp4',
  });
};

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
    const res = await createUploadRequest(adminToken, validContent);

    // controller returns 200 with content
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('content');
    expect(res.body.content).toHaveProperty('title', validContent.title);
  });

  it('Non-admin cannot upload content', async () => {
    // create normal user and login
    await request(app).post('/api/auth/signup').send(normalUser);
    const r = await request(app).post('/api/auth/login').send({ email: normalUser.email, password: normalUser.password });
    const token = r.body.token;

    const res = await createUploadRequest(token, validContent);

    expect(res.status).toBe(403);
  });

  it('GET /api/content/:id returns 404 for missing id', async () => {
    const res = await request(app).get('/api/content/99999');
    expect([404, 400]).toContain(res.status);
  });

  const createUserAndLogin = async (userData) => {
    await request(app).post('/api/auth/signup').send(userData);
    const user = await prisma.user.findUnique({ where: { email: userData.email } });
    const loginRes = await request(app).post('/api/auth/login').send({ email: userData.email, password: userData.password });

    return { user, token: loginRes.body.token };
  };

  const createContentRecord = async ({ uploadedBy, planTier, title, isFree = 0 }) => {
    return prisma.content.create({
      data: {
        title,
        description: `${title} description`,
        type: 'video',
        url: `https://example.com/${title.toLowerCase().replace(/\s+/g, '-')}`,
        isFree: planTier === 'free' ? 1 : isFree,
        planTier,
        uploadedBy,
      },
    });
  };

  it.each([null, ''])('treats stored plan tier %p as free for access control', async (storedPlanTier) => {
    const { user, token } = await createUserAndLogin({
      ...normalUser,
      email: `freeuser-${storedPlanTier === null ? 'null' : 'empty'}@example.com`,
    });

    await prisma.user.update({
      where: { id: user.id },
      data: { planTier: storedPlanTier },
    });

    await createContentRecord({ uploadedBy: user.id, planTier: 'free', title: 'Free content' });
    await createContentRecord({ uploadedBy: user.id, planTier: 'basico', title: 'Basico content' });
    await createContentRecord({ uploadedBy: user.id, planTier: 'premium', title: 'Legacy premium content' });

    const res = await request(app).get('/api/content').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.content.some((item) => item.title === 'Free content')).toBe(true);
    expect(res.body.content.some((item) => item.title === 'Basico content')).toBe(false);
    expect(res.body.content.some((item) => item.title === 'Legacy premium content')).toBe(false);
  });

  it.each([
    ['basico', 'basico', true],
    ['basico', 'premium', true],
    ['basico', 'pro', false],
    ['basico', 'master', false],
  ])('allows basico users to access expected content for %s vs %s', async (_userTier, contentTier, expectedVisible) => {
    const { user, token } = await createUserAndLogin({
      ...normalUser,
      email: `basico-${contentTier}-user@example.com`,
    });

    await prisma.user.update({ where: { id: user.id }, data: { planTier: 'basico' } });

    await createContentRecord({ uploadedBy: user.id, planTier: 'free', title: 'Free access content' });
    await createContentRecord({ uploadedBy: user.id, planTier: contentTier, title: `${contentTier} content` });
    await createContentRecord({ uploadedBy: user.id, planTier: 'pro', title: 'Pro content' });
    await createContentRecord({ uploadedBy: user.id, planTier: 'master', title: 'Master content' });

    const res = await request(app).get('/api/content').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.content.some((item) => item.title === 'Free access content')).toBe(true);
    expect(res.body.content.some((item) => item.title === `${contentTier} content`)).toBe(expectedVisible);
    expect(res.body.content.some((item) => item.title === 'Pro content')).toBe(false);
    expect(res.body.content.some((item) => item.title === 'Master content')).toBe(false);
  });

  it.each([
    ['pro', 'free', true],
    ['pro', 'basico', true],
    ['pro', 'premium', true],
    ['pro', 'pro', true],
    ['pro', 'master', false],
  ])('allows pro users to access expected content for %s vs %s', async (_userTier, contentTier, expectedVisible) => {
    const { user, token } = await createUserAndLogin({
      ...normalUser,
      email: `pro-${contentTier}-user@example.com`,
    });

    await prisma.user.update({ where: { id: user.id }, data: { planTier: 'pro' } });

    await createContentRecord({ uploadedBy: user.id, planTier: 'free', title: 'Free access content' });
    await createContentRecord({ uploadedBy: user.id, planTier: contentTier, title: `${contentTier} content` });
    await createContentRecord({ uploadedBy: user.id, planTier: 'master', title: 'Master content' });

    const res = await request(app).get('/api/content').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.content.some((item) => item.title === 'Free access content')).toBe(true);
    expect(res.body.content.some((item) => item.title === `${contentTier} content`)).toBe(expectedVisible);
    expect(res.body.content.some((item) => item.title === 'Master content')).toBe(false);
  });

  it.each([
    ['master', 'free', true],
    ['master', 'basico', true],
    ['master', 'pro', true],
    ['master', 'master', true],
    ['master', 'premium', true],
  ])('allows master users to access expected content for %s vs %s', async (_userTier, contentTier, expectedVisible) => {
    const { user, token } = await createUserAndLogin({
      ...normalUser,
      email: `master-${contentTier}-user@example.com`,
    });

    await prisma.user.update({ where: { id: user.id }, data: { planTier: 'master' } });

    await createContentRecord({ uploadedBy: user.id, planTier: contentTier, title: `${contentTier} content` });

    const res = await request(app).get('/api/content').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.content.some((item) => item.title === `${contentTier} content`)).toBe(expectedVisible);
  });

  it('denies all content to users with an invalid tier', async () => {
    const { user, token } = await createUserAndLogin({
      ...normalUser,
      email: 'invalid-tier-user@example.com',
    });

    await prisma.user.update({ where: { id: user.id }, data: { planTier: 'gold' } });

    await createContentRecord({ uploadedBy: user.id, planTier: 'free', title: 'Free content for invalid tier user' });
    await createContentRecord({ uploadedBy: user.id, planTier: 'basico', title: 'Basico content for invalid tier user' });
    await createContentRecord({ uploadedBy: user.id, planTier: 'pro', title: 'Pro content for invalid tier user' });
    await createContentRecord({ uploadedBy: user.id, planTier: 'master', title: 'Master content for invalid tier user' });
    await createContentRecord({ uploadedBy: user.id, planTier: 'premium', title: 'Legacy premium content for invalid tier user' });

    const res = await request(app).get('/api/content').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.content.some((item) => item.title === 'Free content for invalid tier user')).toBe(false);
    expect(res.body.content.some((item) => item.title === 'Basico content for invalid tier user')).toBe(false);
    expect(res.body.content.some((item) => item.title === 'Pro content for invalid tier user')).toBe(false);
    expect(res.body.content.some((item) => item.title === 'Master content for invalid tier user')).toBe(false);
    expect(res.body.content.some((item) => item.title === 'Legacy premium content for invalid tier user')).toBe(false);
  });

  it('does not return unknown content tiers to normal users and denies direct access', async () => {
    const { user, token } = await createUserAndLogin({
      ...normalUser,
      email: 'unknown-tier-user@example.com',
    });

    await prisma.user.update({ where: { id: user.id }, data: { planTier: 'basico' } });

    const unknownContent = await createContentRecord({ uploadedBy: user.id, planTier: 'unknown', title: 'Unknown tier content' });

    const listRes = await request(app).get('/api/content').set('Authorization', `Bearer ${token}`);
    const accessRes = await request(app).get(`/api/content/${unknownContent.id}`).set('Authorization', `Bearer ${token}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.content.some((item) => item.title === 'Unknown tier content')).toBe(false);
    expect(accessRes.status).toBe(403);
    expect(accessRes.body).toHaveProperty('error');
  });

  it('allows admins to bypass content access filtering', async () => {
    const { user } = await createUserAndLogin({
      ...normalUser,
      email: 'admin-access-user@example.com',
    });

    await prisma.user.update({ where: { id: user.id }, data: { planTier: 'free' } });
    await createContentRecord({ uploadedBy: user.id, planTier: 'master', title: 'Protected admin content' });

    const res = await request(app).get('/api/content').set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.content.some((item) => item.title === 'Protected admin content')).toBe(true);
  });

  it.each(['free', 'basico', 'pro', 'master'])('accepts upload plan tier %s', async (planTier) => {
    const res = await createUploadRequest(adminToken, {
      ...validContent,
      title: `${planTier} upload test`,
      plan_tier: planTier,
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('message', 'Content uploaded');
    expect(res.body.content).toHaveProperty('plan_tier', planTier);
  });

  it.each(['premium', 'PREMIUM', 'BASICO', 'unknown'])('rejects upload plan tier %p', async (planTier) => {
    const res = await createUploadRequest(adminToken, {
      ...validContent,
      title: `${planTier} invalid upload test`,
      plan_tier: planTier,
    });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });


  it('normalizes a whitespace-padded canonical upload plan tier', async () => {
    const res = await createUploadRequest(adminToken, {
      ...validContent,
      title: 'Whitespace plan tier upload test',
      plan_tier: ' basico ',
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('message', 'Content uploaded');
    expect(res.body.content).toHaveProperty('plan_tier', 'basico');
  });

});
