import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import 'dotenv/config';
import { globalLimiter } from './middleware/rateLimiter.js';
import { getUploadsPath } from './config/uploads.js';
import authRoutes from './routes/auth.js';
import contentRoutes from './routes/content.js';
import statsRoutes from './routes/stats.js';
import mediaRoutes from './routes/media.js';
import adminRoutes from './routes/admin.js';
import paymentsRoutes from './routes/payments.js';
import webhooksRoutes, { stripeWebhookHandler } from './routes/webhooks.js';
import { assertStripeWebhookConfig } from './services/stripeWebhook.js';

if (process.env.NODE_ENV === 'production') {
  // Fail the process/cold start before accepting any unsigned payment event.
  // On Vercel this also enforces NODEJS_HELPERS=0 so no JSON getter touches
  // the payload before express.raw reads the exact bytes Stripe signed.
  assertStripeWebhookConfig();
}

const app = express();
const stripeWebhookRawBody = express.raw({
  type: 'application/json',
  limit: '1mb',
  inflate: false,
});

app.set('trust proxy', 1);
app.use(helmet());

// Stripe authenticates these requests cryptographically. Mount both raw-body
// paths before the generic IP limiter so legitimate event bursts cannot receive
// a pre-verification 429 instead of the documented webhook status contract.
app.use('/api/webhooks', stripeWebhookRawBody, webhooksRoutes);
app.post('/api/payments/webhook', stripeWebhookRawBody, stripeWebhookHandler);
app.use(globalLimiter);

// Ensure a JWT secret exists for tests/development if not provided
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'teclia_dev_secret_change_this';
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

if (process.env.LOCAL_UPLOADS?.toLowerCase() === 'true') {
  const localUploadsPath = getUploadsPath();
  app.use('/uploads/content', (_req, res) => res.status(404).json({ error: 'Media not found' }));
  app.use('/uploads', express.static(localUploadsPath));
}

app.use('/api/auth', authRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/payments', paymentsRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'Teclia Backend is running' });
});

app.use((err, _req, res, _next) => {
  console.error(err.stack || err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
