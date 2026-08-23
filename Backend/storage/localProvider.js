import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { getUploadsPath } from '../config/uploads.js';

const DEFAULT_ALLOWED_TYPES = 'image/jpeg,image/png,application/pdf';
const DEFAULT_MAX_SIZE_MB = 10;

const getUploadRoot = () => path.resolve(getUploadsPath());

const getSigningSecret = () => {
  const secret = process.env.MEDIA_SIGNING_SECRET?.trim();
  if (!secret) {
    throw new Error('MEDIA_SIGNING_SECRET must be defined for local signed media URLs');
  }
  return secret;
};

const normalizeStoragePath = (storagePath) => {
  if (typeof storagePath !== 'string' || !storagePath.trim()) {
    throw new Error('Invalid storage path');
  }

  const candidate = storagePath.trim();
  if (
    candidate.includes('\0') ||
    candidate.includes('\\') ||
    // Local upload keys are canonical UUID-based names. Literal percent-escape
    // sequences are intentionally forbidden so residual double encoding cannot
    // be confused with a real storage key. Uploads must normalize away '%'.
    /%[0-9a-f]{2}/i.test(candidate) ||
    path.posix.isAbsolute(candidate) ||
    path.win32.isAbsolute(candidate)
  ) {
    throw new Error('Invalid storage path');
  }

  const segments = candidate.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid storage path');
  }

  return segments.join('/');
};

const signaturePayload = (storagePath, expiresAt, downloadName = '') => (
  `${storagePath}\n${expiresAt}\n${downloadName}`
);

const createSignature = (storagePath, expiresAt, downloadName = '') => (
  createHmac('sha256', getSigningSecret())
    .update(signaturePayload(storagePath, expiresAt, downloadName))
    .digest('hex')
);

const getAllowedTypes = () => {
  const raw = process.env.UPLOAD_ALLOWED_TYPES || DEFAULT_ALLOWED_TYPES;
  return raw.split(',').map((value) => value.trim()).filter(Boolean);
};

const getMaxSizeBytes = () => {
  const raw = process.env.UPLOAD_MAX_SIZE_MB || DEFAULT_MAX_SIZE_MB;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1024 * 1024 : DEFAULT_MAX_SIZE_MB * 1024 * 1024;
};

const ensureWithinRoot = (targetPath) => {
  const normalized = normalizeStoragePath(targetPath);
  const root = getUploadRoot();
  const resolved = path.resolve(root, normalized);
  const relative = path.relative(root, resolved);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Invalid storage path');
  }
  return resolved;
};

const createRelativePath = (destination, filename) => {
  const normalizedDestination = destination.replace(/^\/+|\/+$/g, '');
  return normalizedDestination
    ? `${normalizedDestination}/${filename}`
    : filename;
};

const validateFile = (file) => {
  if (!file) {
    throw new Error('No file provided');
  }

  const allowedTypes = getAllowedTypes();
  if (allowedTypes.length > 0 && file.mimetype && !allowedTypes.includes(file.mimetype)) {
    throw new Error(`File type ${file.mimetype} is not allowed`);
  }

  const maxBytes = getMaxSizeBytes();
  if (typeof file.size === 'number' && file.size > maxBytes) {
    throw new Error(`File exceeds the maximum size of ${maxBytes / 1024 / 1024}MB`);
  }
};

const saveFileBuffer = async (file, destination) => {
  const uploadRoot = getUploadRoot();
  const absoluteDestination = path.resolve(uploadRoot, destination);
  await fs.mkdir(absoluteDestination, { recursive: true });

  const extension = path.extname(file.originalname || file.name || '').toLowerCase();
  const filename = `${randomUUID()}${extension}`;
  const finalPath = path.join(absoluteDestination, filename);

  if (file.buffer) {
    await fs.writeFile(finalPath, file.buffer);
  } else if (file.path) {
    await fs.copyFile(file.path, finalPath);
    if (fsSync.existsSync(file.path)) {
      await fs.unlink(file.path).catch(() => {});
    }
  } else {
    throw new Error('Unsupported file input for local storage');
  }

  return createRelativePath(destination, filename);
};

const localProvider = {
  /**
   * Stores a file in the local uploads directory.
   *
   * @param {object} file - Multer file object.
   * @param {string} destination - Relative subfolder, for example: 'content' or 'avatars'.
   * @returns {Promise<string>} Relative storage path such as 'content/uuid.png'.
   */
  async upload(file, destination = '') {
    validateFile(file);
    const normalizedDestination = (destination || '').replace(/^\/+|\/+$/g, '');
    return saveFileBuffer(file, normalizedDestination);
  },

  /**
   * Deletes a file from the local uploads directory.
   *
   * @param {string} storagePath - Relative storage path previously returned by upload().
   * @returns {Promise<void>}
   */
  async delete(storagePath) {
    if (!storagePath) return;

    const resolvedPath = ensureWithinRoot(storagePath);
    await fs.unlink(resolvedPath).catch((error) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
  },

  /**
   * Builds a URL-friendly path for the stored file.
   *
   * @param {string} storagePath - Relative storage path previously returned by upload().
   * @returns {string} URL path such as '/uploads/content/uuid.png'.
   */
  resolveUrl(storagePath) {
    if (!storagePath) return '';
    const normalized = normalizeStoragePath(storagePath);
    if (normalized.startsWith('content/')) {
      const query = new URLSearchParams({ path: normalized });
      return `/api/media/public?${query.toString()}`;
    }
    return `/uploads/${normalized}`;
  },

  /**
   * Builds an HMAC-protected, time-limited URL for a local file.
   *
   * @param {string} storagePath - Relative storage path previously returned by upload().
   * @param {{ expiresInSeconds: number, downloadName?: string }} options - Signing options.
   * @returns {string} Local signed media route.
   */
  resolveSignedUrl(storagePath, { expiresInSeconds, downloadName } = {}) {
    const normalized = normalizeStoragePath(storagePath);
    const parsedExpiry = Number(expiresInSeconds);
    if (!Number.isInteger(parsedExpiry) || parsedExpiry <= 0) {
      throw new Error('expiresInSeconds must be a positive integer');
    }

    const safeDownloadName = downloadName ? path.basename(downloadName) : '';
    const expiresAt = Math.floor(Date.now() / 1000) + parsedExpiry;
    const signature = createSignature(normalized, expiresAt, safeDownloadName);
    const query = new URLSearchParams({
      path: normalized,
      exp: String(expiresAt),
      sig: signature,
    });

    if (safeDownloadName) {
      query.set('downloadName', safeDownloadName);
    }

    return `/api/media/signed?${query.toString()}`;
  },

  /**
   * Validates and serves a URL produced by resolveSignedUrl().
   */
  serveSignedFile(req, res) {
    try {
      const normalized = normalizeStoragePath(req.query.path);
      const expiresAt = Number(req.query.exp);
      const suppliedSignature = req.query.sig;
      const downloadName = req.query.downloadName ? path.basename(req.query.downloadName) : '';

      if (!Number.isInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
        return res.status(403).json({ error: 'Signed media URL has expired' });
      }

      if (typeof suppliedSignature !== 'string' || !/^[a-f0-9]{64}$/i.test(suppliedSignature)) {
        return res.status(403).json({ error: 'Invalid signed media URL' });
      }

      const expectedSignature = Buffer.from(createSignature(normalized, expiresAt, downloadName), 'hex');
      const receivedSignature = Buffer.from(suppliedSignature, 'hex');
      // timingSafeEqual throws when lengths differ, so fail closed before comparing.
      if (
        expectedSignature.length !== receivedSignature.length ||
        !timingSafeEqual(expectedSignature, receivedSignature)
      ) {
        return res.status(403).json({ error: 'Invalid signed media URL' });
      }

      const absolutePath = ensureWithinRoot(normalized);
      const remainingSeconds = expiresAt - Math.floor(Date.now() / 1000);
      res.set('Cache-Control', `private, max-age=${remainingSeconds}`);

      if (downloadName) {
        return res.download(absolutePath, downloadName);
      }
      return res.sendFile(absolutePath);
    } catch (_error) {
      return res.status(403).json({ error: 'Invalid signed media URL' });
    }
  },

  /**
   * Serves a local file after the caller has independently established that it is public.
   */
  servePublicFile(storagePath, res) {
    try {
      const absolutePath = ensureWithinRoot(storagePath);
      res.set('Cache-Control', 'public, max-age=3600');
      return res.sendFile(absolutePath);
    } catch (_error) {
      return res.status(404).json({ error: 'Media not found' });
    }
  },
};

export default localProvider;
