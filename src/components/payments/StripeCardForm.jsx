import { useState, useRef, useCallback, useEffect } from 'react';
import { useCheckoutPayment, CHECKOUT_STATUS } from '../../hooks/useCheckoutPayment.js';
import { generateIdempotencyKey } from '../../services/api.js';
import { t } from '../../i18n/messages.js';
import { useAuth } from '../../hooks/useAuth.js';

/**
 * StripeCardForm - Strict checkout contract
 * - Creates PaymentMethod client-side (mocked; PCI: no PAN in app payloads)
 * - Calls paymentsService.submitPaymentMethod via useCheckoutPayment
 * - On HTTP success, only treats status === succeeded as success
 * - processing/pending => confirming polling
 * - failed => error + allow retry with new idempotency key
 * - Stores idempotency key + plan in sessionStorage
 * - Uses i18n via t()
 * - Accessibility: aria-live polite, disable double submit
 */
export const StripeCardForm = ({ planTier, onSuccess, onCancel }) => {
  const { refreshSession } = useAuth();
  const [cardNumber, setCardNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvc, setCvc] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => {
    try {
      const stored = sessionStorage.getItem('checkout_idempotency_key');
      if (stored) return stored;
    } catch {}
    const k = generateIdempotencyKey();
    try { sessionStorage.setItem('checkout_idempotency_key', k); } catch {}
    return k;
  });
  const cardRef = useRef(null);

  // Security: clear card data on unmount to reduce memory exposure
  useEffect(() => {
    return () => {
      setCardNumber('');
      setExpiry('');
      setCvc('');
    };
  }, []);

  const handleSuccess = useCallback(async (payment) => {
    // Clear card inputs (PCI: minimize PAN in memory)
    setCardNumber('');
    setExpiry('');
    setCvc('');
    if (cardRef.current) cardRef.current.clear?.();
    // Refresh auth/entitlements
    try {
      await refreshSession();
    } catch {}
    // Navigate consistently - caller decides
    if (onSuccess) onSuccess(payment);
  }, [refreshSession, onSuccess]);

  const {
    status,
    data,
    error,
    code,
    submit,
    retry,
    isSubmitting,
  } = useCheckoutPayment({ onSuccess: handleSuccess });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;

    // Basic client-side validation (still server validates authoritatively)
    const sanitizedPlan = typeof planTier === 'string' ? planTier.trim().toLowerCase() : '';
    if (!sanitizedPlan) return;

    // PCI invariant: never send PAN; simulate Stripe createPaymentMethod
    // In real integration: const { paymentMethod } = await stripe.createPaymentMethod({ type: 'card', card: cardElement })
    // Generate mock pm id in safe format matching backend regex
    const mockPaymentMethodId = `pm_mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    let effectiveKey = idempotencyKey;
    // Ensure we have a key (defense-in-depth)
    if (!effectiveKey || typeof effectiveKey !== 'string' || effectiveKey.trim().length < 8) {
      effectiveKey = generateIdempotencyKey();
      setIdempotencyKey(effectiveKey);
      try { sessionStorage.setItem('checkout_idempotency_key', effectiveKey); } catch {}
    }

    try {
      await submit({
        planTier: sanitizedPlan,
        paymentMethodId: mockPaymentMethodId,
        idempotencyKey: effectiveKey.trim(),
      });
    } catch {
      // error handled via hook state
    }
  };

  const handleRetry = () => {
    const newKey = generateIdempotencyKey();
    setIdempotencyKey(newKey);
    try { sessionStorage.setItem('checkout_idempotency_key', newKey); } catch {}
    retry();
  };

  const isProcessing = status === CHECKOUT_STATUS.CREATING_PM || status === CHECKOUT_STATUS.SUBMITTING;
  const isConfirming = status === CHECKOUT_STATUS.CONFIRMING;
  const isSucceeded = status === CHECKOUT_STATUS.SUCCEEDED;
  const isFailed = status === CHECKOUT_STATUS.FAILED;
  const isIdle = status === CHECKOUT_STATUS.IDLE;

  const getStatusMessage = () => {
    if (isSucceeded) {
      return t('checkout.succeeded_message', { plan: planTier });
    }
    if (isFailed) {
      if (code === 'ADMIN_PURCHASE_FORBIDDEN') return t('checkout.error_admin_forbidden');
      if (code === 'INVALID_PLAN_TIER') return t('checkout.error_invalid_plan');
      return error || t('checkout.failed_message');
    }
    if (isConfirming) return t('checkout.polling');
    if (isProcessing) return t('checkout.processing');
    return '';
  };

  const statusMessage = getStatusMessage();

  return (
    <form onSubmit={handleSubmit} className="checkout-form" noValidate>
      <div className="form-group">
        <label htmlFor="stripe-card-number">{t('checkout.card_number')}</label>
        <input
          id="stripe-card-number"
          type="text"
          inputMode="numeric"
          placeholder="4242 4242 4242 4242"
          value={cardNumber}
          onChange={(e) => setCardNumber(e.target.value)}
          disabled={isSubmitting || isSucceeded}
          autoComplete="cc-number"
          aria-label={t('checkout.card_number')}
        />
      </div>
      <div className="form-row">
        <div className="form-group half-width">
          <label htmlFor="stripe-expiry">{t('checkout.expiry')}</label>
          <input
            id="stripe-expiry"
            type="text"
            placeholder="12/28"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            disabled={isSubmitting || isSucceeded}
            autoComplete="cc-exp"
          />
        </div>
        <div className="form-group half-width">
          <label htmlFor="stripe-cvc">{t('checkout.cvc')}</label>
          <input
            id="stripe-cvc"
            type="text"
            inputMode="numeric"
            placeholder="123"
            value={cvc}
            onChange={(e) => setCvc(e.target.value)}
            disabled={isSubmitting || isSucceeded}
            autoComplete="cc-csc"
          />
        </div>
      </div>

      {/* aria-live polite for status */}
      <div
        className={`payment-status ${isSucceeded ? 'success' : isFailed ? 'error' : isConfirming ? 'confirming' : ''}`}
        aria-live="polite"
        aria-atomic="true"
        role="status"
      >
        {statusMessage && <span>{statusMessage}</span>}
        {isConfirming && (
          <span className="checkout-spinner" aria-hidden="true"> ⏳</span>
        )}
      </div>

      {isSucceeded && data && (
        <div className="payment-success-details" aria-live="polite">
          <strong>{t('checkout.succeeded_title')}</strong>
          <p>{t('checkout.succeeded_message', { plan: data.planTier || planTier })}</p>
        </div>
      )}

      {isFailed && (
        <div className="payment-error-actions">
          <button type="button" className="button button-secondary" onClick={handleRetry}>
            {t('checkout.retry')}
          </button>
        </div>
      )}

      <div className="checkout-actions">
        {onCancel && (
          <button type="button" className="button button-secondary" onClick={onCancel} disabled={isSubmitting}>
            {t('checkout.back')}
          </button>
        )}
        <button
          type="submit"
          className="button button-primary"
          disabled={isSubmitting || isSucceeded}
          aria-busy={isSubmitting}
        >
          {isProcessing ? t('checkout.processing') : isConfirming ? t('checkout.confirming') : t('checkout.simulate_pay')}
        </button>
      </div>

      <p className="checkout-mock-note">{t('checkout.mock_note')}</p>

      {/* Hidden debug for polling */}
      {isConfirming && (
        <p className="checkout-hint" aria-live="polite">{t('checkout.success_polling_note')}</p>
      )}

      {/* PCI invariant reminder for developers */}
      <span style={{ display: 'none' }} data-testid="pci-invariant">no-pan-in-payload</span>
    </form>
  );
};

export default StripeCardForm;
