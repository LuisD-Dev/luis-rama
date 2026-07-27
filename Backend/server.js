import 'dotenv/config';
import { connectDb } from './db/init.js';
import app from './app.js';

const PORT = process.env.PORT || 3001;

if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET not set — using development fallback');
  process.env.JWT_SECRET = 'teclia_dev_secret_change_this';
}

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
