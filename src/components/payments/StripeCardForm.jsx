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
import { useState } from 'react';
import { CardElement, Elements, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import { paymentsService } from '../../services/api.js';
import { submitAndApplyPaymentMethodResponse } from './paymentResult.js';

const stripePublishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY?.trim();
const PAYMENTS_ENABLED = import.meta.env.VITE_PAYMENTS_ENABLED === 'true';
const paymentsAvailable = PAYMENTS_ENABLED && Boolean(stripePublishableKey);
const stripePromise = paymentsAvailable ? loadStripe(stripePublishableKey) : null;

const cardElementOptions = {
  hidePostalCode: true,
  style: {
    base: {
      color: '#f5f5f5',
      fontFamily: 'Manrope, system-ui, sans-serif',
      fontSize: '16px',
      '::placeholder': {
        color: '#9ca3af',
      },
    },
    invalid: {
      color: '#b42318',
    },
  },
};

const stripeErrorMessages = {
  card_declined: 'La tarjeta fue rechazada. Prueba con otra tarjeta o consulta con tu banco.',
  expired_card: 'La tarjeta está vencida. Usa una tarjeta vigente.',
  incorrect_cvc: 'El código de seguridad no es correcto. Revísalo e inténtalo de nuevo.',
  processing_error: 'No pudimos procesar la tarjeta. Espera un momento e inténtalo de nuevo.',
  incomplete_number: 'Completa el número de la tarjeta.',
  incomplete_expiry: 'Completa la fecha de vencimiento.',
  incomplete_cvc: 'Completa el código de seguridad.',
  invalid_number: 'El número de la tarjeta no es válido. Revísalo e inténtalo de nuevo.',
  invalid_expiry_month: 'El mes de vencimiento no es válido.',
  invalid_expiry_year: 'El año de vencimiento no es válido.',
  invalid_cvc: 'El código de seguridad no es válido.',
};

const getStripeErrorMessage = (error) => {
  const code = error?.code || error?.decline_code || error?.response?.data?.code;
  return stripeErrorMessages[code]
    || 'No pudimos procesar tu método de pago. Revisa los datos e inténtalo de nuevo.';
};

function StripeCardFormContent({ submitLabel, successMessage, onSuccess }) {
  const stripe = useStripe();
  const elements = useElements();
  const [status, setStatus] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!stripe || !elements || isProcessing) return;

    const card = elements.getElement(CardElement);
    if (!card) {
      setStatus({ type: 'error', message: 'El formulario de pago no está listo. Recarga la página e inténtalo de nuevo.' });
      return;
    }

    setIsProcessing(true);
    setStatus(null);

    try {
      const { error, paymentMethod } = await stripe.createPaymentMethod({
        type: 'card',
        card,
      });

      if (error) {
        setStatus({ type: 'error', message: getStripeErrorMessage(error) });
        return;
      }

      // PCI: the backend receives only Stripe's opaque identifier, never card data.
      // Generate or reuse client idempotency key for this checkout attempt
      const existingKey = sessionStorage.getItem('checkout_idempotency_key');
      const idempotencyKey = existingKey || crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      if (!existingKey) sessionStorage.setItem('checkout_idempotency_key', idempotencyKey);

      // Determine plan stored by CheckoutFlow
      const planTier = sessionStorage.getItem('checkout_plan');

      const result = await submitAndApplyPaymentMethodResponse(
        () => paymentsService.submitPaymentMethod(paymentMethod.id, {
          idempotencyKey,
          planTier,
        }),
        {
          successMessage,
          successValue: paymentMethod.id,
          onStatus: setStatus,
          onSuccess: (successfulPaymentMethodId, payment) => {
            card.clear();
            sessionStorage.removeItem('checkout_idempotency_key');
            onSuccess?.(successfulPaymentMethodId, payment);
          },
        },
      );

      if (result.releaseIdempotencyKey && !result.completed) {
        sessionStorage.removeItem('checkout_idempotency_key');
      }
    } catch (error) {
      setStatus({ type: 'error', message: getStripeErrorMessage(error) });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <form className="payment-form stripe-payment-form" onSubmit={handleSubmit}>
      <div className="form-group">
        <label>Datos de la tarjeta</label>
        <div className="stripe-card-element">
          <CardElement options={cardElementOptions} />
        </div>
      </div>

      {status && (
        <div
          key={status.message}
          className={
            status.type === 'success'
              ? 'success-message payment-status success'
              : status.type === 'error'
                ? 'error-message payment-status error animate-shake'
                : 'payment-status'
          }
          role={status.type === 'error' ? 'alert' : 'status'}
        >
          {status.message}
        </div>
      )}

      <button type="submit" className="button button-primary button-block" disabled={!stripe || isProcessing}>
        {isProcessing ? (
          <span className="btn-loading"><span className="spinner" /> Procesando…</span>
        ) : submitLabel}
      </button>
      <p className="payment-note">Los datos de la tarjeta se envían de forma segura directamente a Stripe.</p>
    </form>
  );
}

export default function StripeCardForm({
  submitLabel = 'Guardar método de pago',
  successMessage = 'Método de pago guardado correctamente.',
  onSuccess,
}) {
  if (!paymentsAvailable) {
    return (
      <div className="payment-unavailable" role="status">
        <p>Los pagos no están disponibles en este momento.</p>
        <button type="button" className="button button-primary" disabled>
          Pagos no disponibles
        </button>
      </div>
    );
  }

  return (
    <Elements stripe={stripePromise}>
      <StripeCardFormContent submitLabel={submitLabel} successMessage={successMessage} onSuccess={onSuccess} />
    </Elements>
  );
}
