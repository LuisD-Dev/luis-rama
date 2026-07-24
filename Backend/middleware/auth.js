import jwt from 'jsonwebtoken';
import {
  TOKEN_MISSING,
  TOKEN_INVALID,
  TOKEN_EXPIRED,
  INSUFFICIENT_ROLE,
  UNAUTHORIZED,
  INVALID_AUTH_HEADER,
  PAYLOAD_INVALID,
  PAYLOAD_MISSING,
  TOKEN_MISSING_MESSAGE,
  TOKEN_INVALID_MESSAGE,
  TOKEN_EXPIRED_MESSAGE,
  INSUFFICIENT_ROLE_MESSAGE,
  UNAUTHORIZED_MESSAGE,
  INVALID_AUTH_HEADER_MESSAGE,
  PAYLOAD_INVALID_MESSAGE,
  PAYLOAD_MISSING_MESSAGE,
} from '../constants/authErrors.js';

const requiredJwtFields = ['role', 'iat', 'exp'];

const formatAuthError = (res, status, error, code) => {
  return res.status(status).json({ error, code });
};

export const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    return formatAuthError(res, 401, TOKEN_MISSING_MESSAGE, TOKEN_MISSING);
  }

  if (!authHeader.startsWith('Bearer ')) {
    return formatAuthError(res, 401, INVALID_AUTH_HEADER_MESSAGE, INVALID_AUTH_HEADER);
  }

  const token = authHeader.slice(7);
  if (!token) {
    return formatAuthError(res, 401, TOKEN_MISSING_MESSAGE, TOKEN_MISSING);
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return formatAuthError(res, 401, TOKEN_EXPIRED_MESSAGE, TOKEN_EXPIRED);
    }
    if (err.name === 'JsonWebTokenError') {
      return formatAuthError(res, 401, TOKEN_INVALID_MESSAGE, TOKEN_INVALID);
    }
    return formatAuthError(res, 401, UNAUTHORIZED_MESSAGE, UNAUTHORIZED);
  }

  const payloadKeys = Object.keys(decoded);
  const hasId = payloadKeys.includes('id');
  const hasUserId = payloadKeys.includes('userId');
  const missingFields = requiredJwtFields.filter((field) => !payloadKeys.includes(field));
  if (!hasId && !hasUserId) {
    missingFields.push('id/userId');
  }

  if (missingFields.length > 0) {
    return formatAuthError(
      res,
      401,
      PAYLOAD_MISSING_MESSAGE,
      PAYLOAD_MISSING
    );
  }

  const userId = hasId ? decoded.id : decoded.userId;
  if (typeof userId === 'undefined' || typeof decoded.role !== 'string' || typeof decoded.iat !== 'number' || typeof decoded.exp !== 'number') {
    return formatAuthError(res, 401, PAYLOAD_INVALID_MESSAGE, PAYLOAD_INVALID);
  }

  req.user = {
    id: userId,
    role: decoded.role,
    iat: decoded.iat,
    exp: decoded.exp,
    ...(decoded.planTier ? { planTier: decoded.planTier } : {}),
  };

  next();
};

export const optionalAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    return next();
  }

  if (!authHeader.startsWith('Bearer ')) {
    return formatAuthError(res, 401, INVALID_AUTH_HEADER_MESSAGE, INVALID_AUTH_HEADER);
  }

  const token = authHeader.slice(7);
  if (!token) {
    return formatAuthError(res, 401, TOKEN_MISSING_MESSAGE, TOKEN_MISSING);
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return formatAuthError(res, 401, TOKEN_EXPIRED_MESSAGE, TOKEN_EXPIRED);
    }
    if (err.name === 'JsonWebTokenError') {
      return formatAuthError(res, 401, TOKEN_INVALID_MESSAGE, TOKEN_INVALID);
    }
    return formatAuthError(res, 401, UNAUTHORIZED_MESSAGE, UNAUTHORIZED);
  }

  const payloadKeys = Object.keys(decoded);
  const hasId = payloadKeys.includes('id');
  const hasUserId = payloadKeys.includes('userId');
  const missingFields = requiredJwtFields.filter((field) => !payloadKeys.includes(field));
  if (!hasId && !hasUserId) {
    missingFields.push('id/userId');
  }

  if (missingFields.length > 0) {
    return formatAuthError(
      res,
      401,
      PAYLOAD_MISSING_MESSAGE,
      PAYLOAD_MISSING
    );
  }

  const userId = hasId ? decoded.id : decoded.userId;
  if (typeof userId === 'undefined' || typeof decoded.role !== 'string' || typeof decoded.iat !== 'number' || typeof decoded.exp !== 'number') {
    return formatAuthError(res, 401, PAYLOAD_INVALID_MESSAGE, PAYLOAD_INVALID);
  }

  req.user = {
    id: userId,
    role: decoded.role,
    iat: decoded.iat,
    exp: decoded.exp,
    ...(decoded.planTier ? { planTier: decoded.planTier } : {}),
  };

  next();
};

export const adminOnly = (req, res, next) => {
  if (!req.user) {
    return formatAuthError(res, 401, UNAUTHORIZED_MESSAGE, UNAUTHORIZED);
  }

  if (req.user.role !== 'admin') {
    return formatAuthError(res, 403, INSUFFICIENT_ROLE_MESSAGE, INSUFFICIENT_ROLE);
  }

  next();
};
