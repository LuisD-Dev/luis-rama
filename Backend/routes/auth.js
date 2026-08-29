import multer from 'multer';
import express from 'express';
import {
  signup,
  login,
  logout,
  refresh,
  getMe,
  updateProfile,
  changePassword,
  forgotPassword,
  resetPassword,
  verifyRecoveryEmail,
  updateStudentPlan,
  deleteStudent,
  listStudents,
  updateStudentStatus,
} from '../controllers/authController.js';
import { verifyToken, adminOnly } from '../middleware/auth.js';
import validate from '../middleware/validate.js';
import { authLimiter } from '../middleware/rateLimiter.js';
import * as authSchemas from '../schemas/auth.schema.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten imágenes'));
    }
  },
});

router.post('/signup', authLimiter, validate(authSchemas.register), signup);
router.post('/login', authLimiter, validate(authSchemas.login), login);
router.post('/refresh', authLimiter, validate(authSchemas.refresh), refresh);
router.post('/logout', logout);
router.get('/me', verifyToken, getMe);
router.patch('/profile', verifyToken, upload.single('avatar'), updateProfile);
router.post('/change-password', verifyToken, changePassword);
router.post('/forgot-password', authLimiter, validate(authSchemas.forgotPassword), forgotPassword);
router.post('/reset-password', authLimiter, validate(authSchemas.resetPassword), resetPassword);
router.post('/verify-recovery-email', validate(authSchemas.verifyRecoveryEmail), verifyRecoveryEmail);
router.get('/students', verifyToken, adminOnly, listStudents);
router.patch('/students/:id/plan', verifyToken, adminOnly, updateStudentPlan);
router.delete('/students/:id', verifyToken, adminOnly, deleteStudent);
router.patch('/users/:id/status', verifyToken, adminOnly, updateStudentStatus);

export default router;
