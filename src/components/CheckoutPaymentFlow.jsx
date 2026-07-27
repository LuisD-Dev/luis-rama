import { useState } from 'react';
import { createPaymentIntent } from '../services/api';

export default function CheckoutPaymentFlow({ planTier, token }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [paymentId, setPaymentId] = useState(null);
  const [success, setSuccess] = useState(false);

  async function handleConfirm() {
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const data = await createPaymentIntent(planTier, token);

      if (!data?.paymentId) {
        throw new Error('No se recibió paymentId del backend');
      }

      setPaymentId(data.paymentId);
      setSuccess(true);
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
      {success && paymentId && <p>Compra confirmada. Payment ID: {paymentId}</p>}
    </div>
  );
}