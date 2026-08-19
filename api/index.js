import { connectDb } from '../Backend/db/init.js';
import app from '../Backend/app.js';

let dbReady = connectDb().catch((err) => {
  console.error('Database connection failed:', err);
  throw err;
});

export default async function handler(req, res) {
  await dbReady;
  return app(req, res);
}
