import axios from 'axios';
import { getRequestSignal, invokeLogout } from '../utils/authSession.js';
import { getCsrfToken, getStoredToken, generateCsrfToken } from '../utils/jwt.js';

const REMOTE_BACKEND_BASE_URL = import.meta.env.VITE_BACKEND_BASE_URL || 'https://teclia-academia-2.onrender.com';
export const BACKEND_BASE_URL = import.meta.env.DEV ? '' : REMOTE_BACKEND_BASE_URL;
const API_BASE_URL = import.meta.env.DEV ? '/api' : `${REMOTE_BACKEND_BASE_URL}/api`;

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

const AUTH_ENDPOINTS = /\/auth\/(login|signup|forgot-password|reset-password)/;

// Add JWT token, CSRF token, and abort signal to requests
api.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  let csrf = getCsrfToken();
  if (!csrf) {
    csrf = generateCsrfToken();
  }
  if (csrf && !config.url.includes('/auth/')) {
    config.headers['X-CSRF-Token'] = csrf;
  }
  if (csrf && !config.url.includes('/auth/')) {
    config.headers['X-CSRF-Token'] = csrf;
  }
  config.signal = getRequestSignal();
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    const url = error.config?.url ?? '';
    const isAuthEndpoint = AUTH_ENDPOINTS.test(url);

    if (status === 401 && !isAuthEndpoint) {
      invokeLogout({ reason: 'expired', showToast: true, redirectTo: '/auth/login' });
    }

    return Promise.reject(error);
  },
);

export const authService = {
  signup: (email, password, name) =>
    api.post('/auth/signup', { email, password, name }),
  login: (email, password) =>
    api.post('/auth/login', { email, password }),
  logout: () =>
    api.post('/auth/logout'),
  getCurrentUser: () =>
    api.get('/auth/me'),
  updateProfile: (name, avatar) => {
    if (avatar instanceof FormData) {
      return api.patch('/auth/profile', avatar, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });
    }

    const payload = {};
    if (name) payload.name = name;
    if (avatar) payload.avatarUrl = avatar;
    return api.patch('/auth/profile', payload);
  },
  changePassword: (currentPassword, newPassword) =>
    api.post('/auth/change-password', { currentPassword, newPassword }),
  forgotPassword: (email) =>
    api.post('/auth/forgot-password', { email }),
  resetPassword: (email, pin, newPassword) =>
    api.post('/auth/reset-password', { email, pin, newPassword }),
  verifyRecoveryEmail: (email) =>
    api.post('/auth/verify-recovery-email', { email }),
  getStudents: () =>
    api.get('/auth/students'),
  updateStudentPlan: (studentId, planTier) =>
    api.patch(`/auth/students/${studentId}/plan`, { plan_tier: planTier }),
  deleteStudent: (studentId) =>
    api.delete(`/auth/students/${studentId}`),
  updateStudentStatus: (studentId, status) =>
    api.patch(`/admin/users/${studentId}/status`, { status }),
};

export const adminService = {
  getDashboardStats: () =>
    api.get('/admin/stats'),
  getAuditEvents: (params = {}) =>
    api.get('/admin/audit', { params }),
  deleteContent: (contentId) =>
    api.delete(`/content/${contentId}`),
};

export const statsService = {
  recordVisit: () => api.post('/stats/visit'),
  getVisitStats: () => api.get('/stats/visits'),
};

export const contentService = {
  getContent: () =>
    api.get('/content'),
  getContentById: (id) =>
    api.get(`/content/${id}`),
  getFreeContent: () =>
    api.get('/content/free'),
};

export default api;
