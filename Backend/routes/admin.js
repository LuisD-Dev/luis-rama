import express from 'express';
import { verifyToken, adminOnly } from '../middleware/auth.js';
import { getAdminStats } from '../controllers/statsController.js';
import { listAuditEvents, verifyAudit } from '../controllers/adminAuditController.js';

const router = express.Router();

router.get('/stats', verifyToken, adminOnly, getAdminStats);
router.get('/audit', verifyToken, adminOnly, listAuditEvents);
router.get('/audit/verify', verifyToken, adminOnly, verifyAudit);

export default router;
