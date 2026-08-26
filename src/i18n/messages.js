export const messages = {
  es: {
    risk_challenge: 'Se requiere verificación adicional. Por favor inicia sesión de nuevo o espera unos minutos antes de reintentar.',
    risk_block: 'Tu intento de pago fue bloqueado por medidas de seguridad. Si crees que es un error, contacta soporte.',
    risk_cooldown: 'Has alcanzado el límite de intentos. Espera unos minutos antes de volver a intentar.',
    risk_reauth: 'Por seguridad, necesitas volver a iniciar sesión para continuar con el pago.',
  },
  en: {
    risk_challenge: 'Additional verification required. Please log in again or wait a few minutes before retrying.',
    risk_block: 'Your payment attempt was blocked by security controls. If you think this is a mistake, contact support.',
    risk_cooldown: 'You have reached the attempt limit. Please wait a few minutes before trying again.',
    risk_reauth: 'For security, you need to log in again to continue with payment.',
  },
};

export function getRiskMessage(code, locale = 'es') {
  const dict = messages[locale] || messages.es;
  if (code === 'RISK_CHALLENGE') return dict.risk_challenge;
  if (code === 'RISK_BLOCK') return dict.risk_block;
  return dict.risk_challenge;
}

export const riskErrorCodes = {
  CHALLENGE: 'RISK_CHALLENGE',
  BLOCK: 'RISK_BLOCK',
};

export default messages;
