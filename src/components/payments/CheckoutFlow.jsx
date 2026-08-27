import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth.js';
import StripeCardForm from './StripeCardForm.jsx';
import { t } from '../../i18n/messages.js';

const PLANS = [
  { label: 'Básico',  price: '$9.99',  value: 'basico'  },
  { label: 'Pro',     price: '$24.99', value: 'pro'     },
  { label: 'Master',  price: '$49.99', value: 'master'  },
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
  const navigate = useNavigate();

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

  // Step 1: select_plan
  if (step === 'select_plan') {
    return (
      <div className="checkout-step">
        <h3>{t('checkout.select_plan')}</h3>
        <div className="checkout-plans">
          {PLANS.map((plan) => (
            <button
              key={plan.value}
              type="button"
              className={`checkout-plan-card ${selectedPlan === plan.value ? 'active' : ''}`}
              onClick={() => { setSelectedPlan(plan.value); }}
              aria-pressed={selectedPlan === plan.value}
            >
              <strong>{plan.label}</strong>
              <span className="checkout-price">{plan.price}</span>
            </button>
          ))}
        </div>
        <button
          className="button button-primary"
          disabled={!selectedPlan}
          onClick={() => {
            if (!user) {
              const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
              navigate(`/auth/login?returnTo=${returnTo}`);
              return;
            }
            if (!planData) return;
            setStep('review');
          }}
        >
          {user ? t('checkout.continue') : t('checkout.required_login')}
        </button>
      </div>
    );
  }

  // Step 2: review
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
          </div>
          <div className="checkout-summary-row">
            <span>{t('checkout.user')}</span>
            <span>{user?.email}</span>
          </div>
        </div>
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
          </button>
        </div>
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
      </div>
    );
  }

  return null;
};

export default CheckoutFlow;
