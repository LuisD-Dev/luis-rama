import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { connectDb } from './db/init.js';
import { getUploadsPath } from './config/uploads.js';
import authRoutes from './routes/auth.js';
import contentRoutes from './routes/content.js';
import statsRoutes from './routes/stats.js';
import mediaRoutes from './routes/media.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Ensure a JWT secret exists for development if not provided
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET not set — using development fallback');
  process.env.JWT_SECRET = 'teclia_dev_secret_change_this';
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

if (process.env.LOCAL_UPLOADS?.toLowerCase() === 'true') {
  const localUploadsPath = getUploadsPath();
  app.use('/uploads/content', (_req, res) => res.status(404).json({ error: 'Media not found' }));
  app.use('/uploads', express.static(localUploadsPath));
}

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/media', mediaRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'Teclia Backend is running' });
});

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Initialize database and start server
connectDb()
  .then(() => {
    console.log('✓ Database initialized');
    app.listen(PORT, '0.0.0.0', () => {
  console.log(`✓ Teclia Backend running on port ${PORT}`);
});
  })
  .catch((err) => {
    console.error('✗ Failed to initialize database:', err);
    process.exit(1);
  });
