import prisma from '../utils/prismaClient.js';
import { normalizePlanTier } from '../utils/plans.js';

/**
 * Única puerta de entrada para cambiar el plan de un usuario.
 * Garantiza que planTier y entitlementEpoch cambien juntos, atómicamente.
 * Siempre incrementa el epoch, incluso si el tier no cambia (seguridad > optimización).
 *
 * Si se pasa un `tx` (de una transacción ya abierta por el caller, ej. paymentService),
 * se reutiliza en vez de abrir una transacción nueva — evita anidar transacciones Prisma.
 *
 * @param {object} params
 * @param {number} params.userId
 * @param {string} params.planTier
 * @param {object} [params.extraData] - campos adicionales a actualizar junto al plan (ej. { role: 'premium' })
 * @param {string} [params.reason] - motivo del cambio, para auditoría
 * @param {string} [params.actor] - quién/qué originó el cambio ('stripe', 'admin', userId del admin, etc.)
 * @param {object} [tx] - cliente de transacción Prisma ya abierto, opcional
 */
export async function setUserPlanTier(
  { userId, planTier, extraData = {}, reason, actor },
  tx
) {
  const normalizedTier = normalizePlanTier(planTier);

  const run = (client) =>
    client.user.update({
      where: { id: userId },
      data: {
        planTier: normalizedTier,
        entitlementEpoch: { increment: 1 },
        ...extraData,
      },
    });

  const updatedUser = tx ? await run(tx) : await prisma.$transaction((t) => run(t));

  // Auditoría best-effort — nunca debe romper el flujo de negocio
  console.info('[entitlementService] plan change', {
    userId,
    planTier: normalizedTier,
    reason: reason ?? 'unspecified',
    actor: actor ?? 'unknown',
  });

  return updatedUser;
}
