import express from 'express';
import { verifyToken, adminOnly } from '../middleware/auth.js';
import { getAdminStats } from '../controllers/statsController.js';

const router = express.Router();

router.get('/stats', verifyToken, adminOnly, getAdminStats);

export default router;
