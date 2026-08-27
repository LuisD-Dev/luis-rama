export const messages = {
  es: {
    checkout: {
      select_plan: 'Selecciona tu plan',
      review: 'Revisa tu compra',
      payment_method: 'Método de pago',
      confirming: 'Confirmando pago…',
      succeeded_title: '¡Pago completado!',
      succeeded_message: 'Tu plan {plan} ha sido activado correctamente.',
      failed_title: 'Pago fallido',
      failed_message: 'No se pudo procesar el pago. Intenta de nuevo.',
      processing: 'Procesando…',
      polling: 'Confirmando pago… Espera un momento.',
      retry: 'Reintentar',
      back: 'Atrás',
      continue: 'Continuar',
      go_to_pay: 'Ir a pagar',
      simulate_pay: 'Simular pago',
      card_number: 'Número de tarjeta',
      expiry: 'Expiración',
      cvc: 'CVC',
      plan: 'Plan',
      price: 'Precio',
      currency: 'Moneda',
      user: 'Usuario',
      mock_badge: 'Simulador de pago',
      mock_note: 'Los datos no se almacenan ni procesan. Simulador de pruebas.',
      success_polling_note: 'Tu pago está siendo verificado. No cierres esta ventana.',
      error_admin_forbidden: 'Los administradores no pueden comprar planes.',
      error_invalid_plan: 'Plan no válido.',
      error_generic: 'Ocurrió un error. Intenta de nuevo.',
      error_network: 'Error de red. Verifica tu conexión.',
      idle: 'Listo para pagar',
      creating_pm: 'Creando método de pago…',
      submitting: 'Enviando pago…',
      confirming_label: 'Confirmando',
      succeeded_label: 'Completado',
      failed_label: 'Fallido',
      required_login: 'Inicia sesión para continuar',
      auth_required: 'Debes iniciar sesión para comprar',
    },
    common: {
      close: 'Cerrar',
      loading: 'Cargando…',
    }
  },
  en: {
    checkout: {
      select_plan: 'Select your plan',
      review: 'Review your purchase',
      payment_method: 'Payment method',
      confirming: 'Confirming payment…',
      succeeded_title: 'Payment completed!',
      succeeded_message: 'Your {plan} plan has been activated successfully.',
      failed_title: 'Payment failed',
      failed_message: 'Payment could not be processed. Please try again.',
      processing: 'Processing…',
      polling: 'Confirming payment… Please wait.',
      retry: 'Retry',
      back: 'Back',
      continue: 'Continue',
      go_to_pay: 'Go to pay',
      simulate_pay: 'Simulate payment',
      card_number: 'Card number',
      expiry: 'Expiry',
      cvc: 'CVC',
      plan: 'Plan',
      price: 'Price',
      currency: 'Currency',
      user: 'User',
      mock_badge: 'Payment simulator',
      mock_note: 'Data is not stored or processed. Test simulator.',
      success_polling_note: 'Your payment is being verified. Please do not close this window.',
      error_admin_forbidden: 'Admins cannot purchase plans.',
      error_invalid_plan: 'Invalid plan.',
      error_generic: 'An error occurred. Please try again.',
      error_network: 'Network error. Check your connection.',
      idle: 'Ready to pay',
      creating_pm: 'Creating payment method…',
      submitting: 'Submitting payment…',
      confirming_label: 'Confirming',
      succeeded_label: 'Completed',
      failed_label: 'Failed',
      required_login: 'Log in to continue',
      auth_required: 'You must be logged in to purchase',
    },
    common: {
      close: 'Close',
      loading: 'Loading…',
    }
  }
};

const getNested = (obj, path) => {
  // Prevent prototype pollution via __proto__/constructor/prototype
  if (path.includes('__proto__') || path.includes('constructor') || path.includes('prototype')) return undefined;
  return path.split('.').reduce((acc, key) => {
    if (acc && typeof acc === 'object' && key in acc) return acc[key];
    return undefined;
  }, obj);
};

export const detectLocale = () => {
  if (typeof navigator !== 'undefined' && navigator.language) {
    return navigator.language.toLowerCase().startsWith('en') ? 'en' : 'es';
  }
  return 'es';
};

let currentLocale = detectLocale();

export const setLocale = (locale) => {
  if (messages[locale]) currentLocale = locale;
};

export const getLocale = () => currentLocale;

/**
 * t('checkout.succeeded_message', { plan: 'Pro' })
 */
export const t = (key, params = {}, locale = currentLocale) => {
  const dict = messages[locale] || messages.es;
  let value = getNested(dict, key);
  if (value === undefined) {
    // fallback to es
    value = getNested(messages.es, key);
  }
  if (value === undefined) return key;
  if (typeof value === 'string' && params) {
    return value.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? `{${k}}`);
  }
  return value;
};

export default { messages, t, setLocale, getLocale, detectLocale };
