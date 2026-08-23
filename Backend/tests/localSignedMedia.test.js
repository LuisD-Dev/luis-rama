import { jest } from '@jest/globals';
import { createHmac } from 'crypto';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import request from 'supertest';
import mediaRoutes from '../routes/media.js';
import localProvider from '../storage/localProvider.js';
import { getUploadsPath } from '../config/uploads.js';

const app = express();
app.use('/api/media', mediaRoutes);

const buildSignedUrlForAudit = (
  storagePath,
  { encodedWirePath = encodeURIComponent(storagePath) } = {}
) => {
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const signature = createHmac('sha256', process.env.MEDIA_SIGNING_SECRET)
    .update(`${storagePath}\n${expiresAt}\n`)
    .digest('hex');
  return `/api/media/signed?path=${encodedWirePath}&exp=${expiresAt}&sig=${signature}`;
};

describe('Local signed media URLs', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('serves a file while its signature is valid', async () => {
    const storagePath = await localProvider.upload({
      buffer: Buffer.from('paid lesson'),
      originalname: 'paid-lesson.pdf',
      mimetype: 'application/pdf',
      size: 11,
    }, 'content');

    try {
      const signedUrl = localProvider.resolveSignedUrl(storagePath, {
        expiresInSeconds: 600,
      });
      const response = await request(app).get(signedUrl);

      expect(response.status).toBe(200);
      expect(response.body.toString()).toBe('paid lesson');
      expect(response.headers['cache-control']).toMatch(/^private, max-age=/);
    } finally {
      await localProvider.delete(storagePath);
    }
  });

  it('signs and serves a decoded Unicode filename containing a space', async () => {
    const storagePath = 'content/lección 1.pdf';
    const absolutePath = path.join(getUploadsPath(), storagePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, 'unicode lesson');

    try {
      const signedUrl = localProvider.resolveSignedUrl(storagePath, {
        expiresInSeconds: 600,
      });
      const response = await request(app).get(signedUrl);

      expect(response.status).toBe(200);
      expect(response.body.toString()).toBe('unicode lesson');
    } finally {
      await fs.unlink(absolutePath);
    }
  });

  it('rejects an expired signature', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const signedUrl = localProvider.resolveSignedUrl('content/lesson.pdf', {
      expiresInSeconds: 1,
    });

    jest.setSystemTime(new Date('2026-01-01T00:00:02Z'));
    const response = await request(app).get(signedUrl);

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/expired/i);
  });

  it('rejects a path changed after signing', async () => {
    const signedUrl = localProvider.resolveSignedUrl('content/lesson.pdf', {
      expiresInSeconds: 600,
    });
    const tampered = new URL(signedUrl, 'http://localhost');
    tampered.searchParams.set('path', 'content/other.pdf');

    const response = await request(app).get(`${tampered.pathname}${tampered.search}`);

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/invalid/i);
  });

  it('treats a signature with the wrong length as invalid', async () => {
    const signedUrl = localProvider.resolveSignedUrl('content/lesson.pdf', {
      expiresInSeconds: 600,
    });
    const malformed = new URL(signedUrl, 'http://localhost');
    malformed.searchParams.set('sig', 'aa');

    const response = await request(app).get(`${malformed.pathname}${malformed.search}`);

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/invalid/i);
  });

  it('rejects path traversal and absolute paths', async () => {
    expect(() => localProvider.resolveSignedUrl('../secret.txt', {
      expiresInSeconds: 600,
    })).toThrow(/invalid storage path/i);

    expect(() => localProvider.resolveSignedUrl('C:\\secret.txt', {
      expiresInSeconds: 600,
    })).toThrow(/invalid storage path/i);

    expect(() => localProvider.resolveSignedUrl('/etc/passwd', {
      expiresInSeconds: 600,
    })).toThrow(/invalid storage path/i);

    expect(() => localProvider.resolveSignedUrl('content\\lesson.pdf', {
      expiresInSeconds: 600,
    })).toThrow(/invalid storage path/i);

    expect(() => localProvider.resolveSignedUrl('content/%2e%2e/secret.txt', {
      expiresInSeconds: 600,
    })).toThrow(/invalid storage path/i);

    expect(() => localProvider.resolveSignedUrl('content/%252e%252e/secret.txt', {
      expiresInSeconds: 600,
    })).toThrow(/invalid storage path/i);

    expect(() => localProvider.resolveSignedUrl('content/lesson\0.pdf', {
      expiresInSeconds: 600,
    })).toThrow(/invalid storage path/i);

    const simpleEncodedPath = '../lesson.pdf';
    const simpleEncodedUrl = buildSignedUrlForAudit(simpleEncodedPath, {
      encodedWirePath: '%2e%2e%2flesson.pdf',
    });
    const simpleEncodedResponse = await request(app).get(simpleEncodedUrl);
    expect(simpleEncodedResponse.status).toBe(403);

    // URLSearchParams encodes '%' as '%25'. Express decodes it once, leaving
    // the signed residual '%2e%2e' value for the provider to reject.
    const residualDoubleEncodedPath = 'content/%2e%2e/lesson.pdf';
    const doubleEncodedUrl = buildSignedUrlForAudit(residualDoubleEncodedPath, {
      encodedWirePath: 'content%2f%252e%252e%2flesson.pdf',
    });
    const doubleEncodedResponse = await request(app).get(doubleEncodedUrl);
    expect(doubleEncodedResponse.status).toBe(403);
  });
});
