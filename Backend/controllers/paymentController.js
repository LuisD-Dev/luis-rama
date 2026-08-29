import * as paymentService from '../services/paymentService.js';

export const submitPaymentMethod = async (req, res) => {
  try {
    const { planTier, paymentMethodId, idempotencyKey, amount, ...extra } = req.body;

    // Security: detect and ignore extra fields like client amount (never trust client amount)
    if (amount !== undefined) {
      // Log attempt but don't expose to client; amount is from server map only
      console.warn(`[payments] client sent amount=${amount} for user ${req.user?.id} - ignored (server amount used)`);
    }
    if (Object.keys(extra).length > 0) {
      console.warn(`[payments] unexpected fields in payment-method body: ${Object.keys(extra).join(',')}`);
    }

    if (!planTier) {
      return res.status(400).json({
        error: 'planTier is required',
        code: 'VALIDATION_ERROR',
        fields: { planTier: 'planTier is required' },
      });
    }

    if (!idempotencyKey) {
      return res.status(400).json({
        error: 'idempotencyKey is required',
        code: 'VALIDATION_ERROR',
        fields: { idempotencyKey: 'idempotencyKey is required' },
      });
    }

    const payment = await paymentService.createPayment({
      user: req.user,
      planTier,
      paymentMethodId,
      idempotencyKey,
    });

    const formatted = paymentService.formatPaymentResponse(payment);

    // Always return 200 with explicit status; frontend treats only succeeded as success
    return res.status(200).json(formatted);
  } catch (err) {
    const status = err.status || 500;
    const code = err.code || 'INTERNAL_ERROR';
    // Avoid leaking internal details on 500
    const message = status === 500 ? 'Internal server error' : err.message;
    if (status === 500) console.error('[payments] submit error', err);
    return res.status(status).json({ error: message, code });
  }
};

export const getPaymentStatus = async (req, res) => {
  try {
    const rawId = req.params.id;
    // Strict validation: only digits, no injection, max 10 chars
    if (!/^\d+$/.test(String(rawId)) || String(rawId).length > 10) {
      return res.status(400).json({ error: 'Invalid payment id', code: 'VALIDATION_ERROR' });
    }
    const paymentId = Number(rawId);

    if (!Number.isInteger(paymentId) || paymentId <= 0) {
      return res.status(400).json({ error: 'Invalid payment id', code: 'VALIDATION_ERROR' });
    }

    const payment = await paymentService.getPaymentById({
      paymentId,
      userId: req.user.id,
    });

    return res.status(200).json(paymentService.formatPaymentResponse(payment));
  } catch (err) {
    const status = err.status || 500;
    const code = err.code || 'INTERNAL_ERROR';
    const message = status === 500 ? 'Internal server error' : err.message;
    if (status === 500) console.error('[payments] get status error', err);
    return res.status(status).json({ error: message, code });
  }
};
