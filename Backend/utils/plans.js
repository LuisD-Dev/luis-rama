export const PLAN_TIERS = Object.freeze({
  FREE: 'free',
  BASICO: 'basico',
  PRO: 'pro',
  MASTER: 'master',
  includes(value) {
    return value === PLAN_TIERS.FREE
      || value === PLAN_TIERS.BASICO
      || value === PLAN_TIERS.PRO
      || value === PLAN_TIERS.MASTER;
  },
});

export const PLAN_RANK = Object.freeze({
  [PLAN_TIERS.FREE]: 0,
  [PLAN_TIERS.BASICO]: 1,
  [PLAN_TIERS.PRO]: 2,
  [PLAN_TIERS.MASTER]: 3,
});

export const LEGACY_PLAN_TIER_MAP = Object.freeze({
  premium: PLAN_TIERS.BASICO,
});

export const normalizePlanTier = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value.trim().toLowerCase();
  if (!normalizedValue) {
    return null;
  }

  if (
    Object.prototype.hasOwnProperty.call(
      LEGACY_PLAN_TIER_MAP,
      normalizedValue
    )
  ) {
    return LEGACY_PLAN_TIER_MAP[normalizedValue];
  }

  if (normalizedValue === PLAN_TIERS.FREE) {
    return PLAN_TIERS.FREE;
  }

  if (normalizedValue === PLAN_TIERS.BASICO) {
    return PLAN_TIERS.BASICO;
  }

  if (normalizedValue === PLAN_TIERS.PRO) {
    return PLAN_TIERS.PRO;
  }

  if (normalizedValue === PLAN_TIERS.MASTER) {
    return PLAN_TIERS.MASTER;
  }

  return null;
};

export const canAccessPlan = (userPlanTier, contentPlanTier) => {
  const normalizedContentTier = normalizePlanTier(contentPlanTier);
  const normalizedUserTier = normalizePlanTier(userPlanTier);

  if (!normalizedContentTier || !normalizedUserTier) {
    return false;
  }

  return PLAN_RANK[normalizedUserTier] >= PLAN_RANK[normalizedContentTier];
};
