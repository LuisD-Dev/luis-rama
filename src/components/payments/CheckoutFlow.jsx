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

    setIntentLoading(true);
    setIntentError(null);

    try {
      const data = await createPaymentIntent(planData.value, userToken);

      if (!data?.paymentId) {
        throw new Error('No se recibió confirmación del servidor');
      }

      setPaymentId(data.paymentId);

      if (!PAYMENTS_ENABLED) {
        sessionStorage.removeItem(STORAGE_KEY);
        sessionStorage.removeItem('checkout_resume');
        setSucceeded(true);
        setTimeout(() => onComplete?.(), 2400);
      } else {
        setStep('payment_method');
      }
    } catch (err) {
      const status = err.response?.status;
      const data = err.response?.data || {};
      if (data.code === 'RISK_CHALLENGE' || data.code === 'RISK_BLOCK' || status === 423 || status === 403 && data.error?.startsWith('risk_')) {
        if (data.code === 'RISK_CHALLENGE' || status === 423) {
          setIntentError('Verificación requerida: por favor inicia sesión de nuevo o espera unos minutos antes de reintentar.');
        } else {
          setIntentError('Pago bloqueado por controles de seguridad. Contacta soporte si crees que es un error.');
        }
        if (status === 423) {
          // Trigger re-auth after short delay
          try { const { invokeLogout } = await import('../../utils/authSession.js'); invokeLogout({ reason: 'risk_challenge', showToast: true, redirectTo: '/auth/login' }); } catch {}
        }
      } else if (err.response?.data?.error === 'invalid_plan') {
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
            if (!ensureAuthenticated()) return;
            setStep('review');
          }}
        >
          {user ? 'Continuar' : 'Inicia sesión para continuar'}
        </button>
        <SecureBadge />
      </div>
    );
  }

  if (step === 'review' && planData) {
    return (
      <div className="checkout-step">
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

  if (step === 'payment_method' && planData) {
    const handlePaymentSuccess = () => {
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