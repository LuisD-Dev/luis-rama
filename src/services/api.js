import axios from 'axios';
import { getRequestSignal, invokeLogout } from '../utils/authSession.js';
import { getCsrfToken, getStoredToken, generateCsrfToken } from '../utils/jwt.js';

export const BACKEND_BASE_URL = import.meta.env?.VITE_API_BASE_URL?.replace(/\/api\/?$/, '') || (typeof window !== 'undefined' && window.location.hostname === 'localhost' ? 'http://localhost:3001' : 'https://teclia-academia-2.onrender.com');
const API_BASE_URL = `${BACKEND_BASE_URL}/api`;
const resolveApiBase = () => {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/$/, '');
  }
  if (import.meta.env.PROD) {
    return '/api';
  }
  return 'http://localhost:3001/api';
};

export const BACKEND_BASE_URL = resolveApiBase().replace(/\/api$/, '') || '';
const API_BASE_URL = resolveApiBase();

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

const AUTH_ENDPOINTS = /\/auth\/(login|signup|forgot-password|reset-password)/;

// Add JWT token and abort signal to requests
// Note: CSRF protection via Authorization header (Bearer) is sufficient for JWT (not cookie-based).
// We keep X-CSRF-Token for defense-in-depth where needed, but only once.
api.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // Only add CSRF for non-auth, non-GET where backend might check it
  if (!config.url.includes('/auth/') && config.method && !['get', 'head', 'options'].includes(config.method.toLowerCase())) {
    let csrf = getCsrfToken();
    if (!csrf) {
      csrf = generateCsrfToken();
    }
    if (csrf) config.headers['X-CSRF-Token'] = csrf;
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

export const paymentsService = {
  submitPaymentMethod: ({ planTier, paymentMethodId, idempotencyKey }) =>
    api.post('/payments/payment-method', { planTier, paymentMethodId, idempotencyKey }),
  getPaymentStatus: (paymentId) =>
    api.get(`/payments/${paymentId}`),
};

// PCI invariant: never send PAN (card number) to backend; only Stripe paymentMethodId
// Keep helper for generating idempotency keys (cryptographically random if possible)
export const generateIdempotencyKey = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  submitPaymentMethod: (paymentMethodId, { idempotencyKey, planTier } = {}) =>
    api.post('/payments/payment-method', { paymentMethodId, planTier, idempotencyKey }, { headers: { ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) } }),
};

export default api;

async function request(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || data.message || 'Request failed');
  }

  return data;
}

export async function createPaymentIntent(planTier, token) {
  return request('/payments/intent', {
    method: 'POST',
    body: { plan_tier: planTier },
    token
  });
}

export async function confirmPaymentIntent(paymentId, token) {
  return request(`/payments/intent/${paymentId}/confirm`, {
    method: 'POST',
    token
  });
}
