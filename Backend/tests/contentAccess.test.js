import {
  buildFreeContentWhere,
  getContentPlanTier,
  isContentFree,
} from '../utils/contentAccess.js';
import prisma from '../utils/prismaClient.js';
import { setupTestDb } from './helpers/db.setup.js';

setupTestDb();

describe('Canonical free-content classification', () => {
  it('fails closed when both planTier and the legacy flag are absent or false', () => {
    expect(isContentFree({ planTier: null, isFree: 0 })).toBe(false);
    expect(isContentFree({ planTier: null })).toBe(false);
    expect(isContentFree({})).toBe(false);
    expect(getContentPlanTier({ planTier: null, isFree: 0 })).toBe('basico');
  });

  it('lets an explicit paid plan override a stale legacy free flag', () => {
    expect(isContentFree({ planTier: 'master', isFree: 1 })).toBe(false);
    expect(getContentPlanTier({ planTier: 'master', isFree: 1 })).toBe('master');
  });

  it('keeps the legacy premium alias paid when the legacy free flag is stale', () => {
    const content = { planTier: 'premium', isFree: 1 };

    expect(isContentFree(content)).toBe(false);
    expect(getContentPlanTier(content)).toBe('basico');
  });

  it('supports legacy free rows only when no explicit plan exists', () => {
    expect(isContentFree({ planTier: null, isFree: 1 })).toBe(true);
    expect(getContentPlanTier({ planTier: null, isFree: 1 })).toBe('free');
    expect(buildFreeContentWhere()).toEqual({
      AND: [
        {
          OR: [
            { planTier: 'free' },
            { planTier: null, isFree: 1 },
          ],
        },
        {},
      ],
    });
  });

  it('combines an additional OR with the free predicate through AND in Prisma', async () => {
    const uploader = await prisma.user.create({
      data: {
        email: 'content-access-or@teclia.dev',
        passwordHash: 'not-used-in-this-test',
        name: 'Content Access Test',
        role: 'admin',
      },
    });

    await Promise.all(
      [
        {
          title: 'Search match free',
          description: 'Visible result',
          type: 'article',
          url: 'content/search-free.pdf',
          isFree: 1,
          planTier: 'free',
          uploadedBy: uploader.id,
        },
        {
          title: 'Unrelated free',
          description: 'Does not match the future filter',
          type: 'article',
          url: 'content/unrelated-free.pdf',
          isFree: 1,
          planTier: 'free',
          uploadedBy: uploader.id,
        },
        {
          title: 'Search match paid',
          description: 'Must remain excluded',
          type: 'article',
          url: 'content/search-paid.pdf',
          isFree: 0,
          planTier: 'master',
          uploadedBy: uploader.id,
        },
      ].map((data) => prisma.content.create({ data }))
    );

    const results = await prisma.content.findMany({
      where: buildFreeContentWhere({
        OR: [
          { title: { contains: 'Search match' } },
          { description: { contains: 'future search phrase' } },
        ],
      }),
      orderBy: { title: 'asc' },
    });

    expect(results.map((item) => item.title)).toEqual(['Search match free']);
  });
});
