/**
 * Pure, client-side validation helpers for payment forms.
 *
 * These checks improve form feedback, but they do not replace validation by
 * the payment gateway. Card values are only transformed in memory here; this
 * module never reads from or writes to browser storage.
 */

export const CARD_BRANDS = Object.freeze({
  VISA: 'visa',
  MASTERCARD: 'mastercard',
  AMEX: 'amex',
  UNKNOWN: 'unknown',
});

export const PAYMENT_FIELDS = Object.freeze({
  CARD_NUMBER: 'cardNumber',
  EXPIRY: 'expiry',
  CVC: 'cvc',
});

export const PAYMENT_ERROR_CODES = Object.freeze({
  REQUIRED: 'required',
  INVALID_FORMAT: 'invalid_format',
  INVALID_LENGTH: 'invalid_length',
  UNSUPPORTED_BRAND: 'unsupported_brand',
  INVALID_CHECKSUM: 'invalid_checksum',
  INVALID_MONTH: 'invalid_month',
  EXPIRED: 'expired',
});

const MIN_PAN_LENGTH = 13;
const MAX_PAN_LENGTH = 19;
const PAN_INPUT_PATTERN = /^\d+(?:[ -]\d+)*$/;

const frozenLengths = (...lengths) => Object.freeze(lengths);

export const CARD_BRAND_RULES = Object.freeze({
  [CARD_BRANDS.VISA]: Object.freeze({
    label: 'Visa',
    panLengths: frozenLengths(13, 16, 19),
    cvcLengths: frozenLengths(3),
  }),
  [CARD_BRANDS.MASTERCARD]: Object.freeze({
    label: 'Mastercard',
    panLengths: frozenLengths(16),
    cvcLengths: frozenLengths(3),
  }),
  [CARD_BRANDS.AMEX]: Object.freeze({
    label: 'American Express',
    panLengths: frozenLengths(15),
    cvcLengths: frozenLengths(4),
  }),
  [CARD_BRANDS.UNKNOWN]: Object.freeze({
    label: 'desconocida',
    panLengths: frozenLengths(13, 14, 15, 16, 17, 18, 19),
    // Before an IIN is complete, accepting either size avoids showing a false
    // CVC error. The PAN validator still rejects unsupported brands.
    cvcLengths: frozenLengths(3, 4),
  }),
});

const toInputString = (value) => (value == null ? '' : String(value));

const createError = (field, code, message) => ({ field, code, message });

/** Returns only ASCII digits and never truncates the submitted PAN. */
export const sanitizeCardNumber = (value) => toInputString(value).replace(/\D/g, '');

/**
 * Formats a PAN for real-time display in groups of four. The display value is
 * capped at the maximum ISO/IEC 7812 PAN length; sanitizeCardNumber restores
 * the digits-only value for submission.
 */
export const formatCardNumber = (value) => {
  const digits = sanitizeCardNumber(value).slice(0, MAX_PAN_LENGTH);
  return digits.match(/.{1,4}/g)?.join(' ') ?? '';
};

/** Formats up to four expiry digits as MM/YY for controlled form inputs. */
export const formatExpiry = (value) => {
  const digits = toInputString(value).replace(/\D/g, '').slice(0, 4);
  return digits.length <= 2 ? digits : `${digits.slice(0, 2)}/${digits.slice(2)}`;
};

/** Returns at most four numeric CVC characters for a controlled input. */
export const sanitizeCvc = (value) => toInputString(value).replace(/\D/g, '').slice(0, 4);

/** Detects a supported card brand from its BIN/IIN prefix. */
export const detectCardBrand = (value) => {
  const pan = sanitizeCardNumber(value);

  if (/^4/.test(pan)) {
    return CARD_BRANDS.VISA;
  }

  if (/^3[47]/.test(pan)) {
    return CARD_BRANDS.AMEX;
  }

  if (/^5[1-5]/.test(pan)) {
    return CARD_BRANDS.MASTERCARD;
  }

  if (pan.length >= 4) {
    const iin = Number(pan.slice(0, 4));
    if (iin >= 2221 && iin <= 2720) {
      return CARD_BRANDS.MASTERCARD;
    }
  }

  return CARD_BRANDS.UNKNOWN;
};

/**
 * Runs the Luhn checksum. Spaces and hyphens are accepted as display
 * separators; every other non-numeric character makes the value invalid.
 */
export const isValidLuhn = (value) => {
  const rawValue = toInputString(value).trim();
  if (!rawValue || !PAN_INPUT_PATTERN.test(rawValue)) {
    return false;
  }

  const pan = sanitizeCardNumber(rawValue);
  if (!pan) {
    return false;
  }

  let sum = 0;
  let shouldDouble = false;

  for (let index = pan.length - 1; index >= 0; index -= 1) {
    let digit = Number(pan[index]);

    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }

    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
};

// Concise alias for callers that prefer the algorithm's conventional name.
export const luhnCheck = isValidLuhn;

/** Returns null when the PAN is valid, otherwise a structured Spanish error. */
export const validateCardNumber = (value) => {
  const rawValue = toInputString(value).trim();

  if (!rawValue) {
    return createError(
      PAYMENT_FIELDS.CARD_NUMBER,
      PAYMENT_ERROR_CODES.REQUIRED,
      'Ingresa el número de tarjeta.',
    );
  }

  if (!PAN_INPUT_PATTERN.test(rawValue)) {
    return createError(
      PAYMENT_FIELDS.CARD_NUMBER,
      PAYMENT_ERROR_CODES.INVALID_FORMAT,
      'El número de tarjeta solo puede contener dígitos, espacios o guiones.',
    );
  }

  const pan = sanitizeCardNumber(rawValue);

  if (pan.length < MIN_PAN_LENGTH || pan.length > MAX_PAN_LENGTH) {
    return createError(
      PAYMENT_FIELDS.CARD_NUMBER,
      PAYMENT_ERROR_CODES.INVALID_LENGTH,
      'El número de tarjeta debe tener entre 13 y 19 dígitos.',
    );
  }

  const brand = detectCardBrand(pan);
  if (brand === CARD_BRANDS.UNKNOWN) {
    return createError(
      PAYMENT_FIELDS.CARD_NUMBER,
      PAYMENT_ERROR_CODES.UNSUPPORTED_BRAND,
      'La tarjeta debe ser Visa, Mastercard o American Express.',
    );
  }

  const rules = CARD_BRAND_RULES[brand];
  if (!rules.panLengths.includes(pan.length)) {
    return createError(
      PAYMENT_FIELDS.CARD_NUMBER,
      PAYMENT_ERROR_CODES.INVALID_LENGTH,
      `El número de tarjeta no tiene una longitud válida para ${rules.label}.`,
    );
  }

  if (!isValidLuhn(pan)) {
    return createError(
      PAYMENT_FIELDS.CARD_NUMBER,
      PAYMENT_ERROR_CODES.INVALID_CHECKSUM,
      'El número de tarjeta no es válido.',
    );
  }

  return null;
};

const requireValidDate = (currentDate) => {
  if (!(currentDate instanceof Date) || Number.isNaN(currentDate.getTime())) {
    throw new TypeError('currentDate debe ser una fecha válida.');
  }
  return currentDate;
};

/**
 * Validates MM/YY against the current month. A card remains valid throughout
 * its expiry month. currentDate is injectable so consumers and tests can be
 * deterministic.
 */
export const validateExpiry = (value, currentDate = new Date()) => {
  const expiry = toInputString(value).trim();

  if (!expiry) {
    return createError(
      PAYMENT_FIELDS.EXPIRY,
      PAYMENT_ERROR_CODES.REQUIRED,
      'Ingresa la fecha de expiración.',
    );
  }

  if (!/^\d{2}\/\d{2}$/.test(expiry)) {
    return createError(
      PAYMENT_FIELDS.EXPIRY,
      PAYMENT_ERROR_CODES.INVALID_FORMAT,
      'La fecha de expiración debe tener el formato MM/YY.',
    );
  }

  const [monthText, yearText] = expiry.split('/');
  const month = Number(monthText);

  if (month < 1 || month > 12) {
    return createError(
      PAYMENT_FIELDS.EXPIRY,
      PAYMENT_ERROR_CODES.INVALID_MONTH,
      'El mes de expiración debe estar entre 01 y 12.',
    );
  }

  const today = requireValidDate(currentDate);
  const expiryYear = 2000 + Number(yearText);
  const expiryMonthIndex = expiryYear * 12 + (month - 1);
  const currentMonthIndex = today.getFullYear() * 12 + today.getMonth();

  if (expiryMonthIndex < currentMonthIndex) {
    return createError(
      PAYMENT_FIELDS.EXPIRY,
      PAYMENT_ERROR_CODES.EXPIRED,
      'La tarjeta está expirada.',
    );
  }

  return null;
};

const resolveBrand = (brandOrCardNumber) => {
  if (Object.values(CARD_BRANDS).includes(brandOrCardNumber)) {
    return brandOrCardNumber;
  }
  return detectCardBrand(brandOrCardNumber);
};

/** Returns null when the CVC matches its brand rule, or a structured error. */
export const validateCvc = (value, brandOrCardNumber = CARD_BRANDS.UNKNOWN) => {
  const cvc = toInputString(value).trim();

  if (!cvc) {
    return createError(
      PAYMENT_FIELDS.CVC,
      PAYMENT_ERROR_CODES.REQUIRED,
      'Ingresa el código de seguridad.',
    );
  }

  if (!/^\d+$/.test(cvc)) {
    return createError(
      PAYMENT_FIELDS.CVC,
      PAYMENT_ERROR_CODES.INVALID_FORMAT,
      'El código de seguridad solo puede contener dígitos.',
    );
  }

  const brand = resolveBrand(brandOrCardNumber);
  const rules = CARD_BRAND_RULES[brand];

  if (!rules.cvcLengths.includes(cvc.length)) {
    const expected = rules.cvcLengths.length === 1
      ? `${rules.cvcLengths[0]} dígitos`
      : '3 o 4 dígitos';

    return createError(
      PAYMENT_FIELDS.CVC,
      PAYMENT_ERROR_CODES.INVALID_LENGTH,
      `El código de seguridad debe tener ${expected}.`,
    );
  }

  return null;
};

// Compatibility alias for the common uppercase spelling.
export const validateCVC = validateCvc;

/**
 * Validates the complete pre-gateway form and returns normalized in-memory
 * values plus a flat, UI-friendly error list.
 */
export const validatePaymentDetails = (details = {}, currentDate = new Date()) => {
  const input = details && typeof details === 'object' ? details : {};
  const cardNumber = input.cardNumber ?? input.pan ?? input.number ?? '';
  const expiry = input.expiry ?? input.expiration ?? input.expiryDate ?? '';
  const cvc = input.cvc ?? input.cvv ?? '';
  const brand = detectCardBrand(cardNumber);

  const errors = [
    validateCardNumber(cardNumber),
    validateExpiry(expiry, currentDate),
    validateCvc(cvc, brand),
  ].filter(Boolean);

  return {
    isValid: errors.length === 0,
    brand,
    sanitized: {
      cardNumber: sanitizeCardNumber(cardNumber),
      expiry: toInputString(expiry).trim(),
      cvc: sanitizeCvc(cvc),
    },
    errors,
  };
};

export const validatePaymentForm = validatePaymentDetails;
