export const ALLOWED_PLAN_TIERS = ['basico', 'pro', 'master'];

export const PLAN_AMOUNTS = {
  basico: 999,
  pro: 2499,
  master: 4999,
};

// Security: limits for idempotency keys and payment method ids
export const IDEMPOTENCY_KEY_MIN = 8;
export const IDEMPOTENCY_KEY_MAX = 128;
export const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_\-:.]+$/; // safe chars only, no injection
export const PAYMENT_METHOD_ID_REGEX = /^pm(_mock)?_[A-Za-z0-9_]+$/;
export const PAYMENT_METHOD_ID_MAX = 100;

export const PAYMENT_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
};

export const PAYMENT_CODE = {
  SUCCEEDED: 'PAYMENT_SUCCEEDED',
  PENDING: 'PAYMENT_PENDING',
  PROCESSING: 'PAYMENT_PROCESSING',
  FAILED: 'PAYMENT_FAILED',
  INVALID_PLAN: 'INVALID_PLAN_TIER',
  ADMIN_FORBIDDEN: 'ADMIN_PURCHASE_FORBIDDEN',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  NOT_FOUND: 'PAYMENT_NOT_FOUND',
};

export const TERMINAL_STATUSES = new Set([PAYMENT_STATUS.SUCCEEDED, PAYMENT_STATUS.FAILED]);
export const NON_TERMINAL_STATUSES = new Set([PAYMENT_STATUS.PENDING, PAYMENT_STATUS.PROCESSING]);

export const getAmountForPlan = (planTier) => PLAN_AMOUNTS[planTier] ?? null;

export const isTerminalStatus = (status) => TERMINAL_STATUSES.has(status);
export const isNonTerminalStatus = (status) => NON_TERMINAL_STATUSES.has(status);
