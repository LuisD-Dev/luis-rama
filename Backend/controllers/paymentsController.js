import { createCheckoutSession, PaymentServiceError } from '../services/paymentService.js';

export const checkout = async (req, res) => {
  try {
    const userId = req.user.id;
    const { plan } = req.body;

    const { checkoutUrl, sessionId } = await createCheckoutSession({ userId, plan });

    return res.json({ checkoutUrl, sessionId });
  } catch (err) {
    console.error({
      err: err instanceof PaymentServiceError ? err.message : err,
      stack: err?.stack,
      stripeDetails: err?.cause || undefined,
      timestamp: new Date().toISOString(),
    }, 'Checkout endpoint error');

    if (err instanceof PaymentServiceError) {
      return res.status(err.statusCode).json({ error: err.clientMessage });
    }

    return res.status(502).json({ error: 'Unable to start checkout. Please try again.' });
  }
};

export default { checkout };
