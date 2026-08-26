import crypto from 'crypto';

export const DEFAULT_THRESHOLDS = {
  attemptsUserHour: 8,
  distinctPMsUserDay: 4,
  failsIpHour: 12,
  accountAgeMinutes: 30,
};

export function getThresholds(overrides = {}) {
  return {
    attemptsUserHour: Number(process.env.RISK_THRESHOLD_ATTEMPTS_USER_HOUR ?? overrides.attemptsUserHour ?? DEFAULT_THRESHOLDS.attemptsUserHour),
    distinctPMsUserDay: Number(process.env.RISK_THRESHOLD_DISTINCT_PM_DAY ?? overrides.distinctPMsUserDay ?? DEFAULT_THRESHOLDS.distinctPMsUserDay),
    failsIpHour: Number(process.env.RISK_THRESHOLD_FAILS_IP_HOUR ?? overrides.failsIpHour ?? DEFAULT_THRESHOLDS.failsIpHour),
    accountAgeMinutes: Number(process.env.RISK_ACCOUNT_AGE_MINUTES ?? overrides.accountAgeMinutes ?? DEFAULT_THRESHOLDS.accountAgeMinutes),
  };
}

export function getMode(overrides = {}) {
  const raw = (overrides.mode ?? process.env.RISK_ENGINE_MODE ?? 'shadow').toString().toLowerCase();
  return raw === 'enforce' ? 'enforce' : 'shadow';
}

export function hashIp(ip, salt = process.env.RISK_IP_HASH_SALT || '') {
  if (!ip) return 'unknown';
  const h = crypto.createHash('sha256');
  h.update(`${salt}:${ip}`);
  return h.digest('hex').slice(0, 32);
}

export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || '127.0.0.1';
}

/**
 * Pure deterministic risk evaluation.
 * signals: {
 *   attemptsUserHour: number,
 *   distinctPMsUserDay: number,
 *   failsIpHour: number,
 *   accountAgeMinutes: number|null,
 *   planTier: string,
 *   isWhitelisted?: boolean
 * }
 * Returns { decision: 'allow'|'challenge'|'block', score, reasons, thresholds, signals }
 */
export function evaluate(signals = {}, thresholdsOverrides = {}) {
  const thresholds = getThresholds(thresholdsOverrides);
  const s = {
    attemptsUserHour: Number(signals.attemptsUserHour ?? 0),
    distinctPMsUserDay: Number(signals.distinctPMsUserDay ?? 0),
    failsIpHour: Number(signals.failsIpHour ?? 0),
    accountAgeMinutes: signals.accountAgeMinutes != null ? Number(signals.accountAgeMinutes) : null,
    planTier: (signals.planTier || '').toString().toLowerCase(),
    isWhitelisted: Boolean(signals.isWhitelisted),
  };

  if (s.isWhitelisted) {
    return {
      decision: 'allow',
      score: 0,
      reasons: ['whitelisted'],
      thresholds,
      signals: s,
    };
  }

  let score = 0;
  const reasons = [];
  let decision = 'allow';

  // Check block signals first (highest priority)
  if (s.distinctPMsUserDay >= thresholds.distinctPMsUserDay) {
    decision = 'block';
    score += 40;
    reasons.push(`distinct_pm_limit:${s.distinctPMsUserDay}>=${thresholds.distinctPMsUserDay}`);
  }
  if (s.failsIpHour >= thresholds.failsIpHour) {
    decision = 'block';
    score += 40;
    reasons.push(`fails_ip_limit:${s.failsIpHour}>=${thresholds.failsIpHour}`);
  }

  // Challenge signals (only if not already block)
  if (s.attemptsUserHour >= thresholds.attemptsUserHour) {
    score += 25;
    reasons.push(`attempts_user_hour:${s.attemptsUserHour}>=${thresholds.attemptsUserHour}`);
    if (decision === 'allow') decision = 'challenge';
  }

  if (s.accountAgeMinutes != null && s.planTier === 'master' && s.accountAgeMinutes < thresholds.accountAgeMinutes) {
    score += 25;
    reasons.push(`new_account_master:${s.accountAgeMinutes}<${thresholds.accountAgeMinutes}`);
    if (decision === 'allow') decision = 'challenge';
  }

  if (reasons.length === 0) {
    reasons.push('no_risk_signals');
  }

  score = Math.min(100, score);

  return { decision, score, reasons, thresholds, signals: s };
}

export function shouldEnforce(decision, mode) {
  if (mode === 'shadow') return false;
  return decision === 'block' || decision === 'challenge';
}

export function httpStatusForDecision(decision) {
  if (decision === 'block') return 403;
  if (decision === 'challenge') return 423;
  return 200;
}

export async function collectSignals({ userId, ipHash, paymentMethodId, planTier, prismaClient }) {
  const prisma = prismaClient || (await import('../utils/prismaClient.js')).default;
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  let attemptsUserHour = 0;
  let distinctPMsUserDay = 0;
  let failsIpHour = 0;
  let accountAgeMinutes = null;
  let isWhitelisted = false;

  try {
    if (userId) {
      attemptsUserHour = await prisma.payment.count({
        where: { userId: Number(userId), createdAt: { gte: hourAgo } },
      });

      const recent = await prisma.payment.findMany({
        where: { userId: Number(userId), createdAt: { gte: dayAgo } },
        select: { paymentMethodId: true },
      });
      const set = new Set(recent.map((r) => r.paymentMethodId).filter(Boolean));
      if (paymentMethodId) set.add(paymentMethodId);
      distinctPMsUserDay = set.size;

      const user = await prisma.user.findUnique({ where: { id: Number(userId) }, select: { createdAt: true, riskWhitelisted: true } });
      if (user?.createdAt) {
        accountAgeMinutes = (now.getTime() - new Date(user.createdAt).getTime()) / 60000;
      }
      if (user?.riskWhitelisted) isWhitelisted = true;
    }

    if (ipHash && ipHash !== 'unknown') {
      try {
        failsIpHour = await prisma.payment.count({
          where: { ipHash, status: 'failed', createdAt: { gte: hourAgo } },
        });
      } catch (_) {
        failsIpHour = 0;
      }
    }
  } catch (_) {
    // graceful fallback
  }

  return {
    attemptsUserHour,
    distinctPMsUserDay,
    failsIpHour,
    accountAgeMinutes,
    planTier,
    isWhitelisted,
  };
}

export async function persistDecision({ userId, ipHash, path, signals, score, decision, mode, prismaClient }) {
  const prisma = prismaClient || (await import('../utils/prismaClient.js')).default;
  try {
    return await prisma.riskDecision.create({
      data: {
        userId: userId ? Number(userId) : null,
        ipHash,
        path,
        signalsJson: JSON.stringify(signals),
        score,
        decision,
        mode,
      },
    });
  } catch (e) {
    if (e?.code === 'P2003' || String(e?.message).includes('Foreign key')) {
      try {
        return await prisma.riskDecision.create({
          data: {
            userId: null,
            ipHash,
            path,
            signalsJson: JSON.stringify(signals),
            score,
            decision,
            mode,
          },
        });
      } catch {}
    }
    return null;
  }
}

export default { evaluate, getThresholds, getMode, hashIp, getClientIp, httpStatusForDecision, collectSignals, persistDecision, DEFAULT_THRESHOLDS };
