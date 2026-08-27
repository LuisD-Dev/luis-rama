import { useState, useRef, useCallback, useEffect } from 'react';
import { paymentsService } from '../services/api.js';

export const CHECKOUT_STATUS = {
  IDLE: 'idle',
  CREATING_PM: 'creating_pm',
  SUBMITTING: 'submitting',
  CONFIRMING: 'confirming',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
};

const TERMINAL_FAILED_CODES = new Set(['PAYMENT_FAILED']);
const TERMINAL_SUCCESS_CODES = new Set(['PAYMENT_SUCCEEDED']);

/**
 * Strict checkout contract hook.
 * - Only 'succeeded' is success
 * - pending/processing => confirming + polling
 * - failed => error + allow retry with new idempotency key
 * - Poll GET /api/payments/:id every 1.5s up to ~30s
 * - After success: caller should clear session keys, refresh entitlements, navigate
 */
export const useCheckoutPayment = ({ onSuccess, onError } = {}) => {
  const [status, setStatus] = useState(CHECKOUT_STATUS.IDLE);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [code, setCode] = useState(null);
  const [paymentId, setPaymentId] = useState(null);
  const pollRef = useRef(null);
  const attemptsRef = useRef(0);
  const isMountedRef = useRef(true);
  const isSubmittingRef = useRef(false);

  const MAX_POLL_ATTEMPTS = 20; // 20 * 1.5s = 30s
  const POLL_INTERVAL = 1500;

  const clearPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    attemptsRef.current = 0;
    isSubmittingRef.current = false;
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      clearPolling();
    };
  }, [clearPolling]);

  const handleTerminalSuccess = useCallback((payment) => {
    if (!isMountedRef.current) return;
    isSubmittingRef.current = false;
    setStatus(CHECKOUT_STATUS.SUCCEEDED);
    setData(payment);
    setCode(payment.code || 'PAYMENT_SUCCEEDED');
    setError(null);
    clearPolling();
    // Clear checkout session keys (spec: After success: clear checkout session keys)
    try {
      sessionStorage.removeItem('checkout_plan');
      sessionStorage.removeItem('checkout_idempotency_key');
      sessionStorage.removeItem('checkout_payment_id');
    } catch {}
    if (onSuccess) onSuccess(payment);
  }, [onSuccess, clearPolling]);

  const handleTerminalFailure = useCallback((paymentOrError, fallbackCode) => {
    if (!isMountedRef.current) return;
    isSubmittingRef.current = false;
    const payment = paymentOrError && typeof paymentOrError === 'object' && 'status' in paymentOrError ? paymentOrError : null;
    setStatus(CHECKOUT_STATUS.FAILED);
    if (payment) {
      setData(payment);
      setCode(payment.code || fallbackCode || 'PAYMENT_FAILED');
      setError(payment.clientMessage || payment.error || 'Payment failed');
    } else {
      setCode(fallbackCode || 'PAYMENT_FAILED');
      setError(paymentOrError?.message || paymentOrError || 'Payment failed');
    }
    clearPolling();
    // Rotate idempotency key after terminal failure (spec requirement)
    try {
      sessionStorage.removeItem('checkout_idempotency_key');
    } catch {}
    if (onError) onError(paymentOrError);
  }, [onError, clearPolling]);

  const pollPaymentStatus = useCallback(async (id) => {
    attemptsRef.current += 1;
    try {
      const res = await paymentsService.getPaymentStatus(id);
      const payment = res.data;
      if (!isMountedRef.current) return;

      if (payment.status === 'succeeded') {
        handleTerminalSuccess(payment);
        return;
      }
      if (payment.status === 'failed') {
        handleTerminalFailure(payment, payment.code);
        return;
      }
      // still pending/processing -> continue polling
      if (attemptsRef.current >= MAX_POLL_ATTEMPTS) {
        isSubmittingRef.current = false;
        setStatus(CHECKOUT_STATUS.FAILED);
        setError('Timeout confirming payment. Please check later or retry.');
        setCode('PAYMENT_TIMEOUT');
        clearPolling();
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      const statusCode = err.response?.status;
      if (statusCode === 404 || statusCode === 403) {
        handleTerminalFailure(err.response?.data || err, err.response?.data?.code);
      } else if (attemptsRef.current >= MAX_POLL_ATTEMPTS) {
        isSubmittingRef.current = false;
        setStatus(CHECKOUT_STATUS.FAILED);
        setError(err.response?.data?.error || err.message || 'Polling failed');
        setCode(err.response?.data?.code || 'POLLING_ERROR');
        clearPolling();
      }
      // else continue polling on transient errors
    }
  }, [handleTerminalSuccess, handleTerminalFailure, clearPolling]);

  const startPolling = useCallback((id) => {
    clearPolling();
    attemptsRef.current = 0;
    setStatus(CHECKOUT_STATUS.CONFIRMING);
    pollRef.current = setInterval(() => {
      pollPaymentStatus(id);
    }, POLL_INTERVAL);
    // immediate first poll after 1.5s; alternatively we could poll immediately
  }, [clearPolling, pollPaymentStatus]);

  const submit = useCallback(async ({ planTier, paymentMethodId, idempotencyKey }) => {
    if (isSubmittingRef.current || status === CHECKOUT_STATUS.SUBMITTING || status === CHECKOUT_STATUS.CONFIRMING || status === CHECKOUT_STATUS.CREATING_PM) {
      return; // prevent double submit (ref guard handles stale closure)
    }
    isSubmittingRef.current = true;

    setError(null);
    setCode(null);

    // Simulate creating_pm phase (PCI: card data never leaves Stripe)
    setStatus(CHECKOUT_STATUS.CREATING_PM);
    // In real integration, Stripe createPaymentMethod would happen here.
    // We keep a microtask to allow UI to show creating_pm state.
    await new Promise((r) => setTimeout(r, 50));
    if (!isMountedRef.current) {
      isSubmittingRef.current = false;
      return;
    }

    setStatus(CHECKOUT_STATUS.SUBMITTING);

    // Store idempotency key + plan in sessionStorage (spec)
    try {
      if (idempotencyKey) sessionStorage.setItem('checkout_idempotency_key', idempotencyKey);
      if (planTier) sessionStorage.setItem('checkout_plan', planTier);
    } catch {}

    try {
      const res = await paymentsService.submitPaymentMethod({ planTier, paymentMethodId, idempotencyKey });
      const payment = res.data;
      if (!isMountedRef.current) return;

      setData(payment);
      setPaymentId(payment.paymentId);
      setCode(payment.code);

      try {
        if (payment.paymentId) sessionStorage.setItem('checkout_payment_id', String(payment.paymentId));
      } catch {}

      if (payment.status === 'succeeded') {
        handleTerminalSuccess(payment);
        return payment;
      }

      if (payment.status === 'failed') {
        handleTerminalFailure(payment, payment.code);
        return payment;
      }

      if (payment.status === 'pending' || payment.status === 'processing') {
        // Non-terminal -> confirming + polling (keep isSubmitting true until terminal)
        startPolling(payment.paymentId);
        return payment;
      }

      // Unknown status -> treat as failed for safety
      handleTerminalFailure(payment, 'UNKNOWN_STATUS');
      return payment;
    } catch (err) {
      if (!isMountedRef.current) {
        isSubmittingRef.current = false;
        return;
      }
      const dataErr = err.response?.data;
      const message = dataErr?.error || err.message || 'Payment submission failed';
      const errCode = dataErr?.code || 'SUBMISSION_ERROR';
      setCode(errCode);
      // For validation errors like admin forbidden or invalid plan, go to failed
      if (err.response?.status === 403 || err.response?.status === 400) {
        handleTerminalFailure({ message, code: errCode, error: message }, errCode);
      } else {
        isSubmittingRef.current = false;
        setStatus(CHECKOUT_STATUS.FAILED);
        setError(message);
        clearPolling();
        try { sessionStorage.removeItem('checkout_idempotency_key'); } catch {}
        if (onError) onError(err);
      }
      throw err;
    }
  }, [status, handleTerminalSuccess, handleTerminalFailure, startPolling, clearPolling, onError]);

  const reset = useCallback(() => {
    isSubmittingRef.current = false;
    clearPolling();
    setStatus(CHECKOUT_STATUS.IDLE);
    setData(null);
    setError(null);
    setCode(null);
    setPaymentId(null);
  }, [clearPolling]);

  const retry = useCallback(() => {
    isSubmittingRef.current = false;
    // Rotate idempotency key - caller should generate new one
    try { sessionStorage.removeItem('checkout_idempotency_key'); } catch {}
    setStatus(CHECKOUT_STATUS.IDLE);
    setError(null);
    setCode(null);
    // keep data for debugging? but clear it
    // Do not clear paymentId to allow reference
  }, []);

  const isTerminal = status === CHECKOUT_STATUS.SUCCEEDED || status === CHECKOUT_STATUS.FAILED;
  const isPolling = status === CHECKOUT_STATUS.CONFIRMING;
  const isSubmitting = status === CHECKOUT_STATUS.SUBMITTING || status === CHECKOUT_STATUS.CREATING_PM || status === CHECKOUT_STATUS.CONFIRMING;

  return {
    status,
    data,
    error,
    code,
    paymentId,
    submit,
    reset,
    retry,
    isTerminal,
    isPolling,
    isSubmitting,
    clearPolling,
  };
};

export default useCheckoutPayment;
