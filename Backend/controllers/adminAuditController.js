import prisma from '../utils/prismaClient.js';
import { verifyAuditChain } from '../services/adminAuditService.js';

export const listAuditEvents = async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const where = {};
    if (req.query.action) where.action = req.query.action;
    if (req.query.targetType) where.targetType = req.query.targetType;
    if (req.query.targetId) where.targetId = String(req.query.targetId);
    if (req.query.actorUserId) where.actorUserId = Number(req.query.actorUserId);

    const [events, total] = await Promise.all([
      prisma.adminAuditEvent.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, actorUserId: true, action: true, targetType: true, targetId: true,
          requestId: true, beforeJson: true, afterJson: true, prevHash: true, entryHash: true, createdAt: true,
        },
      }),
      prisma.adminAuditEvent.count({ where }),
    ]);
    res.json({ events, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const verifyAudit = async (_req, res) => {
  const result = await verifyAuditChain();
  res.status(result.valid ? 200 : 500).json(result);
};