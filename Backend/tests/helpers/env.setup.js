import 'dotenv/config';

process.env.LOCAL_UPLOADS = 'true';
process.env.MEDIA_SIGNING_SECRET = process.env.MEDIA_SIGNING_SECRET || 'test-media-signing-secret';
process.env.CONTENT_SIGNED_URL_TTL_SECONDS = process.env.CONTENT_SIGNED_URL_TTL_SECONDS || '900';

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

// Force Prisma to prefer WASM/test client engine during tests if supported.
// Set multiple env vars to increase compatibility across Prisma runtime versions.
process.env.TEST_CLIENT_ENGINE = process.env.TEST_CLIENT_ENGINE || 'wasm';
process.env.PRISMA_CLIENT_ENGINE = process.env.PRISMA_CLIENT_ENGINE || 'wasm';
process.env.PRISMA_CLIENT_ENGINE_TYPE = process.env.PRISMA_CLIENT_ENGINE_TYPE || 'wasm';
process.env.PRISMA_FORCE_WASM = process.env.PRISMA_FORCE_WASM || '1';
process.env.TEST_CLIENT_ENGINE_REMOTE_EXECUTOR = process.env.TEST_CLIENT_ENGINE_REMOTE_EXECUTOR || '';
