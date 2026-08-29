import { describe, expect, it, vi } from 'vitest';
import {
  applyPaymentMethodResponse,
  submitAndApplyPaymentMethodResponse,
} from './paymentResult.js';

const apply = (status) => {
  const onStatus = vi.fn();
  const onSuccess = vi.fn();
  const payment = status === undefined ? {} : { status, paymentId: 41 };
  const result = applyPaymentMethodResponse(payment, {
    successMessage: 'Pago confirmado.',
    successValue: 'pm_test',
    onStatus,
    onSuccess,
  });
  return { onStatus, onSuccess, payment, result };
};

describe('payment-method response handling', () => {
  it('invokes completed-payment UX exactly once for succeeded', () => {
    const { onStatus, onSuccess, payment, result } = apply('succeeded');

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith('pm_test', payment);
    expect(onStatus).toHaveBeenCalledWith({ type: 'success', message: 'Pago confirmado.' });
    expect(result).toMatchObject({ completed: true, releaseIdempotencyKey: true });
  });

  it.each(['pending', 'processing'])(
    'keeps %s neutral and does not invoke completed-payment UX',
    (status) => {
      const { onStatus, onSuccess, result } = apply(status);

      expect(onSuccess).not.toHaveBeenCalled();
      expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({
        type: 'processing',
        message: expect.stringContaining('se está procesando'),
      }));
      expect(result).toMatchObject({ completed: false, releaseIdempotencyKey: false });
    }
  );

  it('shows failure UI for failed without invoking success', () => {
    const { onStatus, onSuccess, result } = apply('failed');

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(result).toMatchObject({ completed: false, releaseIdempotencyKey: true });
  });

  it('shows cancellation UI for canceled without invoking success', () => {
    const { onStatus, onSuccess, result } = apply('canceled');

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      message: expect.stringContaining('cancelado'),
    }));
    expect(result).toMatchObject({ completed: false, releaseIdempotencyKey: true });
  });

  it.each([undefined, 'created', 'unexpected'])(
    'fails closed for missing or non-completing status %s',
    (status) => {
      const { onStatus, onSuccess, result } = apply(status);

      expect(onSuccess).not.toHaveBeenCalled();
      expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
      expect(result).toMatchObject({ completed: false, releaseIdempotencyKey: false });
    }
  );

  it.each([
    new Error('Network Error'),
    { response: { status: 502, data: { error: 'provider unavailable' } } },
  ])('preserves rejected HTTP/network handling without invoking success', async (error) => {
    const onStatus = vi.fn();
    const onSuccess = vi.fn();

    await expect(
      submitAndApplyPaymentMethodResponse(
        vi.fn().mockRejectedValue(error),
        { onStatus, onSuccess }
      )
    ).rejects.toBe(error);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
  });
});
