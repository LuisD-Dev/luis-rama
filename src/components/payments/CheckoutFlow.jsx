import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth.js';
import StripeCardForm from './StripeCardForm.jsx';
import { t } from '../../i18n/messages.js';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth.js';
import StripeCardForm from './StripeCardForm.jsx';
import { Confetti } from '../common/Confetti.jsx';
import { createPaymentIntent } from '../../services/api.js';

const PAYMENTS_ENABLED = import.meta.env.VITE_PAYMENTS_ENABLED === 'true';

const PLANS = [
  { label: 'Básico', price: '$9.99', value: 'basico', features: ['Acceso a recursos', 'Lecciones guiadas', 'Comunidad privada'] },
  { label: 'Pro', price: '$24.99', value: 'pro', features: ['Feedback de IA', 'Clases 1:1', 'Partituras exclusivas'] },
  { label: 'Master', price: '$49.99', value: 'master', features: ['Plan personalizado', 'Sesiones premium', 'Análisis avanzado'] },
];

const STORAGE_KEY = 'checkout_plan';
const IDEMPOTENCY_KEY = 'checkout_idempotency_key';
const PAYMENT_ID_KEY = 'checkout_payment_id';

// Normalize plan label/value to canonical value (basico|pro|master)
const normalizePlan = (plan) => {
  if (!plan) return null;
  const found = PLANS.find((p) => p.label === plan || p.value === plan);
  return found ? found.value : null;
};

const planDataFor = (plan) => {
  const normalized = normalizePlan(plan);
  return PLANS.find((p) => p.value === normalized) || null;
};

export const CheckoutFlow = ({ initialPlan, onComplete }) => {
  const { user, refreshSession } = useAuth();
const normalizePlan = (candidate) => (
  PLANS.find((plan) => plan.value === candidate || plan.label === candidate)?.value || null
);

const readStoredPlan = () => {
  const savedPlan = sessionStorage.getItem(STORAGE_KEY);
  const normalizedPlan = normalizePlan(savedPlan);
  if (savedPlan && !normalizedPlan) sessionStorage.removeItem(STORAGE_KEY);
  return normalizedPlan;
};

const SecureBadge = () => (
  <p className="checkout-secure">
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2l7 3v6c0 4.5-3 8.5-7 9-4-.5-7-4.5-7-9V5l7-3z" stroke="currentColor" strokeWidth="1.6" />
      <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
    Pago seguro · Stripe
  </p>
);

export const CheckoutFlow = ({ initialPlan, onComplete, renderPaymentForm }) => {
  const { user, token: userToken } = useAuth();
  const navigate = useNavigate();
  const initialSelection = normalizePlan(initialPlan) || readStoredPlan();
  const [step, setStep] = useState(() => (initialSelection ? 'review' : 'select_plan'));
  const [selectedPlan, setSelectedPlan] = useState(initialSelection);
  const [succeeded, setSucceeded] = useState(false);
  const [paymentId, setPaymentId] = useState(null);
  const [intentLoading, setIntentLoading] = useState(false);
  const [intentError, setIntentError] = useState(null);

  const safeGet = (key) => {
    try { return sessionStorage.getItem(key); } catch { return null; }
  };
  const safeSet = (key, value) => {
    try { sessionStorage.setItem(key, value); } catch {}
  };
  const safeRemove = (key) => {
    try { sessionStorage.removeItem(key); } catch {}
  };

  const [step, setStep] = useState(() => {
    const saved = safeGet(STORAGE_KEY);
    const normalizedSaved = normalizePlan(saved);
    const normalizedInitial = normalizePlan(initialPlan);
    if (normalizedSaved) return 'review';
    if (normalizedInitial) return 'review';
    return 'select_plan';
  });

  const [selectedPlan, setSelectedPlan] = useState(() => {
    const normalizedInitial = normalizePlan(initialPlan);
    if (normalizedInitial) return normalizedInitial;
    const saved = safeGet(STORAGE_KEY);
    const normalizedSaved = normalizePlan(saved);
    return normalizedSaved || null;
  });

  // Persist plan selection (canonical value)
  useEffect(() => {
    if (selectedPlan) {
      const normalized = normalizePlan(selectedPlan);
      if (normalized) safeSet(STORAGE_KEY, normalized);
    } else {
      safeRemove(STORAGE_KEY);
    }
  }, [selectedPlan]);

  const planData = planDataFor(selectedPlan);

  // For succeeded flow after payment
  const [outerStatus, setOuterStatus] = useState(null); // null | succeeded

  const handlePaymentSuccess = useCallback(async (payment) => {
    // Strict contract: only succeeded triggers success flow (defense-in-depth)
    if (!payment || payment.status !== 'succeeded') return;

    // Clear checkout session keys (spec)
    safeRemove(STORAGE_KEY);
    safeRemove(IDEMPOTENCY_KEY);
    safeRemove(PAYMENT_ID_KEY);

    // Refresh entitlements
    try {
      await refreshSession();
    } catch {}

    setOuterStatus('succeeded');
    // Navigate consistently - give user feedback then close
    setTimeout(() => {
      onComplete?.();
    }, 1200);
  }, [refreshSession, onComplete]);

  // Guard: confirmation step cannot be skipped
  // Ensure we never allow direct transition to succeeded without payment
  const canProceedToPayment = !!planData && !!user;
  useEffect(() => {
    if (selectedPlan) sessionStorage.setItem(STORAGE_KEY, selectedPlan);
    else sessionStorage.removeItem(STORAGE_KEY);
  }, [selectedPlan]);

  const planData = PLANS.find((plan) => plan.value === selectedPlan);

  const ensureAuthenticated = () => {
    if (user) return true;
    if (planData) sessionStorage.setItem(STORAGE_KEY, planData.value);
    sessionStorage.setItem('checkout_resume', '1');
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    navigate(`/auth/login?returnTo=${returnTo}`);
    return false;
  };

  const handleProceedToPayment = async () => {
    if (!ensureAuthenticated()) return;

    setIntentError(null);

    // The Stripe payment-method endpoint owns creation of the real Payment.
    // Avoid creating a separate simulated Payment before showing the card form.
    if (PAYMENTS_ENABLED) {
      setStep('payment_method');
      return;
    }

    setIntentLoading(true);

    try {
      const data = await createPaymentIntent(planData.value, userToken);

      if (!data?.paymentId) {
        throw new Error('No se recibió confirmación del servidor');
      }

      setPaymentId(data.paymentId);

      if (data.status === 'succeeded') {
        sessionStorage.removeItem(STORAGE_KEY);
        sessionStorage.removeItem('checkout_resume');
        setSucceeded(true);
        setTimeout(() => onComplete?.(), 2400);
      } else if (data.status === 'pending' || data.status === 'processing') {
        setIntentError('El pago está pendiente de confirmación. Tu acceso todavía no ha sido activado.');
      } else {
        setIntentError('No pudimos completar el pago. Inténtalo nuevamente.');
      }
    } catch (err) {
      if (err.response?.data?.error === 'invalid_plan') {
        setIntentError('El plan seleccionado no es válido. Intenta con otro.');
      } else if (err.message?.includes('Network Error') || err.message?.includes('Failed to fetch')) {
        setIntentError('No se pudo conectar con el servidor. Verifica tu conexión e intenta de nuevo.');
      } else {
        setIntentError(err.response?.data?.error || err.message || 'No se pudo procesar la solicitud. Intenta de nuevo.');
      }
    } finally {
      setIntentLoading(false);
    }
  };

  if (succeeded && planData) {
    return (
      <div className="checkout-step">
        <Confetti />
        <div className="checkout-success">
          <div className="checkout-success-check" aria-hidden="true">✓</div>
          <h3>¡Bienvenido a {planData.label}!</h3>
          <p>
            {paymentId
              ? `Compra registrada exitosamente (ID: ${paymentId}). Ya puedes disfrutar de tu plan.`
              : 'Tu método de pago se registró correctamente. Ya puedes disfrutar de tu plan.'}
          </p>
        </div>
      </div>
    );
  }

  if (step === 'select_plan') {
    return (
      <div className="checkout-step">
        <h3>{t('checkout.select_plan')}</h3>
        <div className="checkout-head">
          <h3>Selecciona tu plan</h3>
          <p>Elige el plan que mejor se adapta a tu ritmo de aprendizaje.</p>
        </div>
        <div className="checkout-plans">
          {PLANS.map((plan) => (
            <button
              key={plan.value}
              type="button"
              className={`checkout-plan-card ${selectedPlan === plan.value ? 'active' : ''}`}
              onClick={() => { setSelectedPlan(plan.value); }}
              aria-pressed={selectedPlan === plan.value}
              aria-pressed={selectedPlan === plan.value}
              onClick={() => setSelectedPlan(plan.value)}
            >
              <strong>{plan.label}</strong>
              <span className="checkout-price">{plan.price}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="button button-primary button-block"
          disabled={!selectedPlan}
          onClick={() => {
            if (!user) {
              const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
              navigate(`/auth/login?returnTo=${returnTo}`);
              return;
            }
            if (!planData) return;
            if (!ensureAuthenticated()) return;
            setStep('review');
          }}
        >
          {user ? t('checkout.continue') : t('checkout.required_login')}
        </button>
        <SecureBadge />
      </div>
    );
  }

  if (step === 'review' && planData) {
    return (
      <div className="checkout-step">
        <h3>{t('checkout.review')}</h3>
        <div className="checkout-summary">
          <div className="checkout-summary-row">
            <span>{t('checkout.plan')}</span>
            <strong>{planData.label}</strong>
          </div>
          <div className="checkout-summary-row">
            <span>{t('checkout.price')}</span>
            <strong>{planData.price}</strong>
          </div>
          <div className="checkout-summary-row">
            <span>{t('checkout.currency')}</span>
            <span>USD</span>
        <div className="checkout-head">
          <h3>Revisa tu compra</h3>
          <p>Confirma los detalles antes de continuar al pago.</p>
        </div>
        <div className="checkout-plan-summary">
          <div>
            <div className="plan-name">Plan {planData.label}</div>
            <div className="text-muted" style={{ fontSize: '0.85rem' }}>Facturación mensual · USD</div>
          </div>
          <div className="plan-cost">{planData.price}</div>
        </div>
        <ul className="lp-plan" style={{ background: 'transparent', border: 'none', padding: 0, boxShadow: 'none', margin: '0 0 1rem' }}>
          {planData.features.map((feature) => (
            <li key={feature}><span className="lp-check" aria-hidden="true">✓</span>{feature}</li>
          ))}
        </ul>
        <div className="checkout-summary">
          <div className="checkout-summary-row">
            <span>{t('checkout.user')}</span>
            <span>{user?.email}</span>
            <span>Cuenta</span>
            <span>{user?.email || 'Sesión requerida'}</span>
          </div>
        </div>

        {intentError && (
          <div className="error-message" role="alert" style={{ marginBottom: '1rem' }}>
            {intentError}
          </div>
        )}

        <div className="checkout-actions">
          <button className="button button-secondary" onClick={() => setStep('select_plan')}>
            {t('checkout.back')}
          </button>
          <button
            className="button button-primary"
            onClick={() => {
              if (!canProceedToPayment) return;
              setStep('payment_method');
            }}
            disabled={!canProceedToPayment}
          >
            {t('checkout.go_to_pay')}
          <button type="button" className="button button-secondary" onClick={() => setStep('select_plan')}>
            Atrás
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={intentLoading}
            onClick={handleProceedToPayment}
          >
            {intentLoading ? (
              <span className="btn-loading"><span className="spinner" /> Procesando…</span>
            ) : (
              user ? 'Ir a pagar' : 'Inicia sesión para pagar'
            )}
          </button>
        </div>
        <SecureBadge />
      </div>
    );
  }

  // Step 3: payment_method - strict contract via StripeCardForm
  if (step === 'payment_method') {
    if (!planData) {
      // Guard: cannot render payment without plan -> back to select
      return (
        <div className="checkout-step">
          <p>{t('checkout.error_invalid_plan')}</p>
          <button className="button button-secondary" onClick={() => setStep('select_plan')}>
            {t('checkout.back')}
          </button>
        </div>
      );
    }

    if (outerStatus === 'succeeded') {
      return (
        <div className="checkout-step" aria-live="polite">
          <h3>{t('checkout.succeeded_title')}</h3>
          <p>{t('checkout.succeeded_message', { plan: planData.label })}</p>
        </div>
      );
    }
  if (step === 'payment_method' && planData) {
    const handlePaymentSuccess = (_paymentMethodId, payment) => {
      if (payment?.status !== 'succeeded') return;

      setPaymentId(payment.paymentId ?? null);
      sessionStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem('checkout_resume');
      setSucceeded(true);
      setTimeout(() => onComplete?.(), 2400);
    };

    const paymentForm = renderPaymentForm
      ? renderPaymentForm({ plan: planData, onSuccess: handlePaymentSuccess })
      : (
        <StripeCardForm
          submitLabel="Pagar ahora"
          successMessage={`Método de pago del plan ${planData.label} enviado correctamente.`}
          onSuccess={handlePaymentSuccess}
        />
      );

    return (
      <div className="checkout-step">
        <span className="checkout-mock-badge">{t('checkout.mock_badge')}</span>
        <h3>{t('checkout.payment_method')}</h3>
        <p className="checkout-hint">{t('checkout.plan')}: <strong>{planData.label}</strong> — {planData.price}</p>
        <div aria-live="polite" aria-atomic="true" className="sr-only" style={{ position: 'absolute', left: '-10000px' }} />
        <StripeCardForm
          planTier={planData.value}
          onSuccess={handlePaymentSuccess}
          onCancel={() => setStep('review')}
        />
        <div className="checkout-head">
          <h3>Método de pago</h3>
          <p>Tus datos se envían cifrados directamente a Stripe.</p>
        </div>
        <div className="checkout-plan-summary">
          <div className="plan-name">Plan {planData.label}</div>
          <div className="plan-cost">{planData.price}</div>
        </div>
        {paymentId && (
          <p className="text-muted" style={{ fontSize: '0.8rem', marginBottom: '0.5rem' }}>
            Intención de pago: {paymentId}
          </p>
        )}
        {paymentForm}
        <button type="button" className="button button-ghost button-block" onClick={() => setStep('review')}>
          Atrás
        </button>
        <SecureBadge />
      </div>
    );
  }

  return null;
};

export default CheckoutFlow;
