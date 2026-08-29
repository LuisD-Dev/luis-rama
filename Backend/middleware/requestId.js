import crypto from 'crypto';

export const requestId = (req, res, next) => {
  const supplied = req.get('X-Request-Id');
  const id = supplied && supplied.length <= 128 ? supplied : crypto.randomUUID();
  req.requestId = id;
  res.set('X-Request-Id', id);
  next();
};