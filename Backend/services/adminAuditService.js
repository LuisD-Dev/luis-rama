import crypto from 'crypto';
import prisma from '../utils/prismaClient.js';

export const GENESIS_HASH = '0'.repeat(64);

const canonicalize = (value) => {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return value;
};

export const serializeAuditValue = (value) => {
  if (value === undefined || value === null) return null;
  return JSON.stringify(canonicalize(value));
};

const hashIp = (ip) => ip
  ? crypto.createHash('sha256').update(`${process.env.AUDIT_IP_SALT || 'teclia-audit'}:${ip}`).digest('hex')
  : null;

const hashEntry = (prevHash, payload) => crypto
  .createHash('sha256')
  .update(prevHash + serializeAuditValue(payload))
  .digest('hex');

export const recordAdminAction = async ({ db = prisma, actorUserId, action, targetType, targetId, requestId, ip, before, after }) => {
  const previous = await db.adminAuditEvent.findFirst({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const prevHash = previous?.entryHash || GENESIS_HASH;
  const beforeJson = serializeAuditValue(before);
  const afterJson = serializeAuditValue(after);
  const payload = { actorUserId, action, targetType, targetId: String(targetId), requestId: requestId || null, ipHash: hashIp(ip), beforeJson, afterJson };
  const entryHash = hashEntry(prevHash, payload);

  return db.adminAuditEvent.create({ data: { ...payload, prevHash, entryHash } });
};

export const verifyAuditChain = async (db = prisma) => {
  const events = await db.adminAuditEvent.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  let prevHash = GENESIS_HASH;
  for (const event of events) {
    const payload = {
      actorUserId: event.actorUserId,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      requestId: event.requestId,
      ipHash: event.ipHash,
      beforeJson: event.beforeJson,
      afterJson: event.afterJson,
    };
    const expected = hashEntry(prevHash, payload);
    if (event.prevHash !== prevHash || event.entryHash !== expected) {
      return { valid: false, eventId: event.id, expected, actual: event.entryHash };
    }
    prevHash = event.entryHash;
  }
  return { valid: true, count: events.length };
};