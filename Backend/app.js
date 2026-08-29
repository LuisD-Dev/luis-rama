import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import 'dotenv/config';
import { globalLimiter } from './middleware/rateLimiter.js';
import { getUploadsPath } from './config/uploads.js';
import authRoutes from './routes/auth.js';
import contentRoutes from './routes/content.js';
import statsRoutes from './routes/stats.js';
import paymentRoutes from './routes/payments.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import mediaRoutes from './routes/media.js';
import adminRoutes from './routes/admin.js';
import { requestId } from './middleware/requestId.js';
import paymentsRoutes from './routes/payments.js';
import webhooksRoutes from './routes/webhooks.js';

const app = express();

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: false, // allow Vite dev; enable strict CSP in prod if needed
  crossOriginEmbedderPolicy: false,
}));
app.use(globalLimiter);
app.use(requestId);

// Ensure a JWT secret exists for tests/development if not provided
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'teclia_dev_secret_change_this';
}
if (process.env.NODE_ENV === 'production' && process.env.JWT_SECRET === 'teclia_dev_secret_change_this') {
  console.error('⚠️  JWT_SECRET is using default dev value in production! Set a strong random secret.');
}

const allowedOrigins = (process.env.FRONTEND_URL || process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const corsOptions = allowedOrigins.length > 0
  ? { origin: allowedOrigins, credentials: true }
  : { origin: true, credentials: true }; // dev: allow all with credentials
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cors());
app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhooksRoutes);
// Stripe subscription webhook needs the exact raw bytes to verify stripe-signature,
// so this must be mounted before the global express.json() below. Scoped to this
// one path — every other /api/payments/* route still gets normal JSON parsing.
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
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
app.use('/api/payments', paymentRoutes);
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
