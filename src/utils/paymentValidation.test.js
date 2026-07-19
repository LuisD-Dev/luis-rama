import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CARD_BRANDS,
  detectCardBrand,
  formatCardNumber,
  formatExpiry,
  isValidLuhn,
  sanitizeCardNumber,
  sanitizeCvc,
  validateCardNumber,
  validateCvc,
  validateExpiry,
  validatePaymentDetails,
} from './paymentValidation.js';

const JULY_2026 = new Date(2026, 6, 18);

afterEach(() => {
  vi.unstubAllGlobals();
});

const expectError = (error, field, code) => {
  expect(error).toEqual(expect.objectContaining({
    field,
    code,
    message: expect.any(String),
  }));
  expect(error.message.length).toBeGreaterThan(0);
};

describe('normalización de datos de tarjeta', () => {
  it('elimina separadores y caracteres no numéricos del PAN', () => {
    expect(sanitizeCardNumber('4111-1111 1111x1111')).toBe('4111111111111111');
  });

  it('formatea el PAN en grupos de cuatro sin alterar sus dígitos', () => {
    const formatted = formatCardNumber('4111111111111111');
    expect(formatted).toBe('4111 1111 1111 1111');
    expect(sanitizeCardNumber(formatted)).toBe('4111111111111111');
  });

  it('formatea también el último grupo incompleto de un PAN de 19 dígitos', () => {
    expect(formatCardNumber('4000000000000000006')).toBe('4000 0000 0000 0000 006');
  });

  it('limita la entrada visual del PAN a 19 dígitos', () => {
    expect(sanitizeCardNumber(formatCardNumber('123456789012345678901'))).toHaveLength(19);
  });

  it('formatea cuatro dígitos de expiración como MM/YY', () => {
    expect(formatExpiry('1a2/3-4-5')).toBe('12/34');
  });

  it('sanitiza y limita el CVC a cuatro dígitos', () => {
    expect(sanitizeCvc('1a2 345')).toBe('1234');
  });
});

describe('detección por BIN/IIN', () => {
  it.each([
    ['4111111111111111', CARD_BRANDS.VISA],
    ['378282246310005', CARD_BRANDS.AMEX],
    ['5555555555554444', CARD_BRANDS.MASTERCARD],
    ['2221000000000009', CARD_BRANDS.MASTERCARD],
    ['2720992712345670', CARD_BRANDS.MASTERCARD],
    ['6011111111111117', CARD_BRANDS.UNKNOWN],
  ])('detecta %s como %s', (pan, expectedBrand) => {
    expect(detectCardBrand(pan)).toBe(expectedBrand);
  });

  it.each(['2220000000000000', '2721000000000000'])('respeta los límites del rango Mastercard: %s', (pan) => {
    expect(detectCardBrand(pan)).toBe(CARD_BRANDS.UNKNOWN);
  });

  it('detecta una Visa aunque el valor ya esté formateado', () => {
    expect(detectCardBrand('4111 1111 1111 1111')).toBe(CARD_BRANDS.VISA);
  });
});

describe('algoritmo de Luhn', () => {
  it.each([
    '4111111111111111',
    '4222222222222',
    '5555555555554444',
    '378282246310005',
    '4000000000000000006',
  ])('acepta el PAN válido %s', (pan) => {
    expect(isValidLuhn(pan)).toBe(true);
  });

  it('acepta separadores visuales permitidos', () => {
    expect(isValidLuhn('4111-1111 1111-1111')).toBe(true);
  });

  it.each([
    '4111111111111112',
    '5555555555554445',
    '378282246310006',
    '',
    '4111x111111111111',
  ])('rechaza el valor inválido %s', (pan) => {
    expect(isValidLuhn(pan)).toBe(false);
  });
});

describe('validación del PAN por marca', () => {
  it.each([
    '4222222222222',
    '4111111111111111',
    '4000000000000000006',
  ])('acepta la longitud Visa válida: %s', (pan) => {
    expect(validateCardNumber(pan)).toBeNull();
  });

  it.each([
    '5555555555554444',
    '2221000000000009',
    '2720992712345670',
  ])('acepta Mastercard de 16 dígitos, incluidos los límites IIN: %s', (pan) => {
    expect(validateCardNumber(pan)).toBeNull();
  });

  it('acepta Amex de 15 dígitos', () => {
    expect(validateCardNumber('378282246310005')).toBeNull();
  });

  it('rechaza un PAN vacío', () => {
    expectError(validateCardNumber('  '), 'cardNumber', 'required');
  });

  it.each([
    '4111 1111 ABCD 1111',
    '4111/1111/1111/1111',
    '4111.1111.1111.1111',
    '----4111111111111111',
    '4111111111111111-',
    '4111  1111 1111 1111',
    '4111\t1111\t1111\t1111',
  ])('rechaza el PAN malformado %s', (pan) => {
    expectError(validateCardNumber(pan), 'cardNumber', 'invalid_format');
  });

  it.each(['411111111111', '41111111111111111111'])('rechaza longitudes fuera del rango global: %s', (pan) => {
    expectError(validateCardNumber(pan), 'cardNumber', 'invalid_length');
  });

  it('rechaza una longitud no admitida específicamente por Visa', () => {
    expectError(validateCardNumber('41111111111111'), 'cardNumber', 'invalid_length');
  });

  it('rechaza una longitud no admitida específicamente por Mastercard', () => {
    expectError(validateCardNumber('555555555555444'), 'cardNumber', 'invalid_length');
  });

  it('rechaza una longitud no admitida específicamente por Amex', () => {
    expectError(validateCardNumber('3782822463100050'), 'cardNumber', 'invalid_length');
  });

  it('rechaza una red no soportada aunque su PAN pase Luhn', () => {
    expectError(validateCardNumber('6011111111111117'), 'cardNumber', 'unsupported_brand');
  });

  it('distingue un checksum incorrecto de un error de formato', () => {
    expectError(validateCardNumber('4111111111111112'), 'cardNumber', 'invalid_checksum');
  });
});

describe('validación de expiración MM/YY', () => {
  it('acepta el mes actual completo', () => {
    expect(validateExpiry('07/26', JULY_2026)).toBeNull();
  });

  it('acepta un mes futuro', () => {
    expect(validateExpiry('08/26', JULY_2026)).toBeNull();
  });

  it('acepta un año futuro', () => {
    expect(validateExpiry('01/27', JULY_2026)).toBeNull();
  });

  it('rechaza el mes inmediatamente anterior', () => {
    expectError(validateExpiry('06/26', JULY_2026), 'expiry', 'expired');
  });

  it('rechaza un año anterior', () => {
    expectError(validateExpiry('12/25', JULY_2026), 'expiry', 'expired');
  });

  it.each(['00/27', '13/27'])('rechaza el mes imposible %s', (expiry) => {
    expectError(validateExpiry(expiry, JULY_2026), 'expiry', 'invalid_month');
  });

  it.each(['7/26', '0726', '07-26', '07/2026', 'ab/cd'])('rechaza el formato malformado %s', (expiry) => {
    expectError(validateExpiry(expiry, JULY_2026), 'expiry', 'invalid_format');
  });

  it('rechaza una expiración vacía', () => {
    expectError(validateExpiry(''), 'expiry', 'required');
  });

  it('rechaza una fecha de referencia inyectada inválida', () => {
    expect(() => validateExpiry('08/26', new Date('invalid'))).toThrow(TypeError);
  });
});

describe('validación de CVC por marca', () => {
  it.each([CARD_BRANDS.VISA, CARD_BRANDS.MASTERCARD])('acepta tres dígitos para %s', (brand) => {
    expect(validateCvc('123', brand)).toBeNull();
  });

  it('acepta cuatro dígitos para Amex', () => {
    expect(validateCvc('1234', CARD_BRANDS.AMEX)).toBeNull();
  });

  it('también puede inferir la marca desde el PAN', () => {
    expect(validateCvc('1234', '378282246310005')).toBeNull();
  });

  it('rechaza cuatro dígitos para Visa', () => {
    expectError(validateCvc('1234', CARD_BRANDS.VISA), 'cvc', 'invalid_length');
  });

  it('rechaza cuatro dígitos para Mastercard', () => {
    expectError(validateCvc('1234', CARD_BRANDS.MASTERCARD), 'cvc', 'invalid_length');
  });

  it('rechaza tres dígitos para Amex', () => {
    expectError(validateCvc('123', CARD_BRANDS.AMEX), 'cvc', 'invalid_length');
  });

  it.each(['12a', '12 3', '12-3'])('rechaza el CVC malformado %s', (cvc) => {
    expectError(validateCvc(cvc, CARD_BRANDS.VISA), 'cvc', 'invalid_format');
  });

  it('rechaza un CVC vacío', () => {
    expectError(validateCvc('', CARD_BRANDS.VISA), 'cvc', 'required');
  });

  it.each(['12', '12345'])('rechaza una longitud CVC desconocida fuera de 3–4: %s', (cvc) => {
    expectError(validateCvc(cvc, CARD_BRANDS.UNKNOWN), 'cvc', 'invalid_length');
  });
});

describe('contrato de errores en español', () => {
  it.each([
    {
      name: 'PAN requerido',
      error: () => validateCardNumber(''),
      expected: { field: 'cardNumber', code: 'required', message: 'Ingresa el número de tarjeta.' },
    },
    {
      name: 'formato de PAN',
      error: () => validateCardNumber('4111/1111/1111/1111'),
      expected: {
        field: 'cardNumber',
        code: 'invalid_format',
        message: 'El número de tarjeta solo puede contener dígitos, espacios o guiones.',
      },
    },
    {
      name: 'longitud global del PAN',
      error: () => validateCardNumber('4111'),
      expected: {
        field: 'cardNumber',
        code: 'invalid_length',
        message: 'El número de tarjeta debe tener entre 13 y 19 dígitos.',
      },
    },
    {
      name: 'marca no admitida',
      error: () => validateCardNumber('6011111111111117'),
      expected: {
        field: 'cardNumber',
        code: 'unsupported_brand',
        message: 'La tarjeta debe ser Visa, Mastercard o American Express.',
      },
    },
    {
      name: 'checksum del PAN',
      error: () => validateCardNumber('4111111111111112'),
      expected: {
        field: 'cardNumber',
        code: 'invalid_checksum',
        message: 'El número de tarjeta no es válido.',
      },
    },
    {
      name: 'expiración requerida',
      error: () => validateExpiry('', JULY_2026),
      expected: { field: 'expiry', code: 'required', message: 'Ingresa la fecha de expiración.' },
    },
    {
      name: 'formato de expiración',
      error: () => validateExpiry('0726', JULY_2026),
      expected: {
        field: 'expiry',
        code: 'invalid_format',
        message: 'La fecha de expiración debe tener el formato MM/YY.',
      },
    },
    {
      name: 'mes de expiración',
      error: () => validateExpiry('13/27', JULY_2026),
      expected: {
        field: 'expiry',
        code: 'invalid_month',
        message: 'El mes de expiración debe estar entre 01 y 12.',
      },
    },
    {
      name: 'tarjeta expirada',
      error: () => validateExpiry('06/26', JULY_2026),
      expected: { field: 'expiry', code: 'expired', message: 'La tarjeta está expirada.' },
    },
    {
      name: 'CVC requerido',
      error: () => validateCvc('', CARD_BRANDS.VISA),
      expected: { field: 'cvc', code: 'required', message: 'Ingresa el código de seguridad.' },
    },
    {
      name: 'formato de CVC',
      error: () => validateCvc('12a', CARD_BRANDS.VISA),
      expected: {
        field: 'cvc',
        code: 'invalid_format',
        message: 'El código de seguridad solo puede contener dígitos.',
      },
    },
    {
      name: 'longitud CVC Visa',
      error: () => validateCvc('1234', CARD_BRANDS.VISA),
      expected: {
        field: 'cvc',
        code: 'invalid_length',
        message: 'El código de seguridad debe tener 3 dígitos.',
      },
    },
    {
      name: 'longitud CVC Amex',
      error: () => validateCvc('123', CARD_BRANDS.AMEX),
      expected: {
        field: 'cvc',
        code: 'invalid_length',
        message: 'El código de seguridad debe tener 4 dígitos.',
      },
    },
  ])('mantiene el mensaje de $name', ({ error, expected }) => {
    expect(error()).toEqual(expected);
  });
});

describe('API agregada', () => {
  it('devuelve datos sanitizados y sin errores para un formulario válido', () => {
    const result = validatePaymentDetails({
      cardNumber: '4111 1111 1111 1111',
      expiry: '08/26',
      cvc: '123',
    }, JULY_2026);

    expect(result).toEqual({
      isValid: true,
      brand: CARD_BRANDS.VISA,
      sanitized: {
        cardNumber: '4111111111111111',
        expiry: '08/26',
        cvc: '123',
      },
      errors: [],
    });
  });

  it('acumula un error estructurado por cada campo inválido', () => {
    const result = validatePaymentDetails({
      cardNumber: '4111x',
      expiry: '00/20',
      cvc: '1a',
    }, JULY_2026);

    expect(result.isValid).toBe(false);
    expect(result.errors).toHaveLength(3);
    expect(result.errors.map(({ field }) => field)).toEqual(['cardNumber', 'expiry', 'cvc']);
    result.errors.forEach(({ code, message }) => {
      expect(code).toEqual(expect.any(String));
      expect(message).toEqual(expect.any(String));
    });
  });

  it('aplica automáticamente la regla de cuatro dígitos de Amex', () => {
    const result = validatePaymentDetails({
      cardNumber: '378282246310005',
      expiry: '12/30',
      cvc: '123',
    }, JULY_2026);

    expect(result.brand).toBe(CARD_BRANDS.AMEX);
    expectError(result.errors[0], 'cvc', 'invalid_length');
  });

  it('no lee ni escribe datos mediante almacenamiento del navegador', () => {
    const localStorageMock = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const sessionStorageMock = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    vi.stubGlobal('localStorage', localStorageMock);
    vi.stubGlobal('sessionStorage', sessionStorageMock);

    validatePaymentDetails({
      cardNumber: '4111111111111111',
      expiry: '12/30',
      cvc: '123',
    }, JULY_2026);

    Object.values(localStorageMock).forEach((storageMethod) => {
      expect(storageMethod).not.toHaveBeenCalled();
    });
    Object.values(sessionStorageMock).forEach((storageMethod) => {
      expect(storageMethod).not.toHaveBeenCalled();
    });
  });
});
