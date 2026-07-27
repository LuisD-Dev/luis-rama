import React, { useState } from 'react';

const CheckoutForm = () => {
  const [planTier, setPlanTier] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/payments/intent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ planTier }),
      });

      if (!response.ok) {
        throw new Error('Error creating payment intent');
      }

      const data = await response.json();
      // Handle successful payment intent creation (e.g., redirect to confirmation page)
      console.log('Payment Intent:', data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <h2>Checkout</h2>
      <label>
        Plan Tier:
        <select value={planTier} onChange={(e) => setPlanTier(e.target.value)} required>
          <option value="">Select a plan</option>
          <option value="basic">Basic</option>
          <option value="premium">Premium</option>
        </select>
      </label>
      <button type="submit" disabled={loading}>
        {loading ? 'Processing...' : 'Pay Now'}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
};

export default CheckoutForm;