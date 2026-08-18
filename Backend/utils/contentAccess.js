const FREE_PLAN_TIER = 'free';
const DEFAULT_PAID_PLAN_TIER = 'basico';
const KNOWN_PAID_PLAN_TIERS = new Set(['basico', 'pro', 'master']);

const hasOwn = (value, property) => (
  value != null && Object.prototype.hasOwnProperty.call(value, property)
);

const readPlanTier = (content) => {
  if (hasOwn(content, 'planTier')) return content.planTier;
  return content?.plan_tier;
};

const readLegacyFreeFlag = (content) => {
  if (hasOwn(content, 'isFree')) return content.isFree;
  return content?.is_free;
};

const isTrueLegacyFreeFlag = (value) => (
  value === 1 || value === true || value === '1'
);

/**
 * Canonical fail-closed free-content predicate.
 * An explicit plan tier always wins. The legacy flag is considered only when
 * the plan tier is null/undefined.
 */
export const isContentFree = (content) => {
  const planTier = readPlanTier(content);

  if (typeof planTier === 'string' && planTier.length > 0) {
    return planTier === FREE_PLAN_TIER;
  }

  if (planTier !== null && typeof planTier !== 'undefined') {
    return false;
  }

  return isTrueLegacyFreeFlag(readLegacyFreeFlag(content));
};

/**
 * Returns the canonical plan tier used by access checks and serializers.
 */
export const getContentPlanTier = (content) => {
  if (isContentFree(content)) return FREE_PLAN_TIER;

  const planTier = readPlanTier(content);
  if (KNOWN_PAID_PLAN_TIERS.has(planTier)) return planTier;

  // Missing legacy tiers remain paid. Unknown explicit tiers fail at master.
  if (typeof planTier === 'string' && planTier.length > 0) return 'master';
  return DEFAULT_PAID_PLAN_TIER;
};

/**
 * Prisma predicate equivalent to isContentFree().
 */
export const buildFreeContentWhere = (additionalWhere = {}) => ({
  AND: [
    {
      OR: [
        { planTier: FREE_PLAN_TIER },
        { planTier: null, isFree: 1 },
      ],
    },
    additionalWhere,
  ],
});
