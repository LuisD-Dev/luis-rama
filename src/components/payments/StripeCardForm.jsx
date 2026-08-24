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
