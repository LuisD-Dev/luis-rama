import { useState } from 'react';
import { createPaymentIntent } from '../services/api';
import { applyPaymentMethodResponse } from './payments/paymentResult.js';

export default function CheckoutPaymentFlow({ planTier, token }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [paymentId, setPaymentId] = useState(null);
  const [success, setSuccess] = useState(false);
  const [statusMessage, setStatusMessage] = useState(null);

  async function handleConfirm() {
    setLoading(true);
    setError(null);
    setSuccess(false);
    setStatusMessage(null);

    try {
      const data = await createPaymentIntent(planTier, token);

      if (!data?.paymentId) {
        throw new Error('No se recibió paymentId del backend');
      }

      applyPaymentMethodResponse(data, {
        successMessage: 'Compra confirmada.',
        onStatus: ({ type, message }) => {
          if (type === 'processing') setStatusMessage(message);
          if (type === 'error') setError(message);
        },
        onSuccess: (_value, payment) => {
          setPaymentId(payment.paymentId);
          setSuccess(true);
        },
      });
    } catch (err) {
      setError(err.message || 'No se pudo completar la compra');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button onClick={handleConfirm} disabled={loading || !token || !planTier}>
        {loading ? 'Procesando...' : 'Confirmar compra'}
      </button>
      {error && <p role="alert">{error}</p>}
      {statusMessage && <p role="status">{statusMessage}</p>}
      {success && paymentId && <p>Compra confirmada. Payment ID: {paymentId}</p>}
    </div>
  );
}
