import { PLAN_TIERS, normalizePlanTier, canAccessPlan } from '../utils/plans.js';

describe('Plan tier utility', () => {
  describe('PLAN_TIERS.includes()', () => {
    it.each([
      ['free', true],
      ['basico', true],
      ['pro', true],
      ['master', true],
      ['premium', false],
      ['PREMIUM', false],
      ['BASICO', false],
      [' basico ', false],
      ['unknown', false],
      ['', false],
      [null, false],
      [undefined, false],
    ])('returns %p for %p', (value, expected) => {
      expect(PLAN_TIERS.includes(value)).toBe(expected);
    });
  });

  describe('normalizePlanTier()', () => {
    it.each([
      ['free', 'free'],
      ['FREE', 'free'],
      [' free ', 'free'],
      ['basico', 'basico'],
      ['BASICO', 'basico'],
      [' basico ', 'basico'],
      ['pro', 'pro'],
      ['PRO', 'pro'],
      ['master', 'master'],
      ['MASTER', 'master'],
      ['premium', 'basico'],
      ['PREMIUM', 'basico'],
      [' premium ', 'basico'],
    ])('normalizes %p to %p', (value, expected) => {
      expect(normalizePlanTier(value)).toBe(expected);
    });

    it.each([
      undefined,
      null,
      '',
      ' ',
      'gold',
      'basic',
      'unknown',
      '__proto__',
      0,
      false,
      {},
      [],
    ])('returns null for invalid value %p', (value) => {
      expect(normalizePlanTier(value)).toBeNull();
    });
  });

  describe('canonical access matrix', () => {
    it.each([
      ['free', 'free', true],
      ['free', 'basico', false],
      ['free', 'pro', false],
      ['free', 'master', false],
      ['basico', 'free', true],
      ['basico', 'basico', true],
      ['basico', 'pro', false],
      ['basico', 'master', false],
      ['pro', 'free', true],
      ['pro', 'basico', true],
      ['pro', 'pro', true],
      ['pro', 'master', false],
      ['master', 'free', true],
      ['master', 'basico', true],
      ['master', 'pro', true],
      ['master', 'master', true],
    ])('allows %s -> %s as %p', (userTier, contentTier, expected) => {
      expect(canAccessPlan(userTier, contentTier)).toBe(expected);
    });
  });

  describe('legacy premium compatibility', () => {
    it.each([
      ['free', 'premium', false],
      ['basico', 'premium', true],
      ['pro', 'premium', true],
      ['master', 'premium', true],
    ])('treats %s accessing premium as %p', (userTier, contentTier, expected) => {
      expect(canAccessPlan(userTier, contentTier)).toBe(expected);
    });

    it.each([
      ['premium', 'free', true],
      ['premium', 'basico', true],
      ['premium', 'pro', false],
      ['premium', 'master', false],
    ])('treats legacy user tier %s as %p', (userTier, contentTier, expected) => {
      expect(canAccessPlan(userTier, contentTier)).toBe(expected);
    });
  });

  describe('invalid and missing values', () => {
    it.each([
      ['unknown', 'free', false],
      ['gold', 'basico', false],
      ['master', 'unknown', false],
      ['master', '', false],
      [null, 'free', false],
      [undefined, 'free', false],
      ['free', null, false],
      ['free', undefined, false],
    ])('returns false for invalid values %p / %p', (userTier, contentTier, expected) => {
      expect(canAccessPlan(userTier, contentTier)).toBe(expected);
    });
  });
});
