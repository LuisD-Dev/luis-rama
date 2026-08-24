const PROCESSING_MESSAGE =
  'El pago se está procesando. Tu acceso se activará cuando Stripe lo confirme.';

const resultForStatus = (status, successMessage) => {
  switch (status) {
    case 'succeeded':
      return {
        type: 'success',
        message: successMessage,
        completed: true,
        releaseIdempotencyKey: true,
      };
    case 'pending':
    case 'processing':
      return {
        type: 'processing',
        message: PROCESSING_MESSAGE,
        completed: false,
        releaseIdempotencyKey: false,
      };
    case 'failed':
      return {
        type: 'error',
        message: 'El pago no pudo completarse. Revisa tu método de pago e inténtalo de nuevo.',
        completed: false,
        releaseIdempotencyKey: true,
      };
    case 'canceled':
      return {
        type: 'error',
        message: 'El pago fue cancelado. Puedes intentarlo nuevamente.',
        completed: false,
        releaseIdempotencyKey: true,
      };
    default:
      return {
        type: 'error',
        message: 'No pudimos confirmar el estado del pago. Inténtalo de nuevo con la misma solicitud.',
        completed: false,
        releaseIdempotencyKey: false,
      };
  }
};

export const applyPaymentMethodResponse = (
  payment,
  { successMessage, successValue, onStatus, onSuccess } = {}
) => {
  const result = resultForStatus(payment?.status, successMessage);
  onStatus?.({ type: result.type, message: result.message });
  if (result.completed) onSuccess?.(successValue, payment);
  return result;
};

export const submitAndApplyPaymentMethodResponse = async (submit, handlers) => {
  const response = await submit();
  return applyPaymentMethodResponse(response?.data, handlers);
};

export default applyPaymentMethodResponse;
