import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';

const cleanEnvValue = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.replace(/^['"]|['"]$/g, '');
};

const getSupabaseConfig = () => {
  const url = cleanEnvValue(process.env.SUPABASE_URL);
  const serviceKey = cleanEnvValue(process.env.SUPABASE_SERVICE_KEY) || cleanEnvValue(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const bucket = cleanEnvValue(process.env.SUPABASE_BUCKET) || 'uploads';

  if (!url || !serviceKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) must be defined');
  }

  return { url, serviceKey, bucket };
};

const getClient = () => {
  const { url, serviceKey } = getSupabaseConfig();
  return createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
};

const normalizeDestination = (destination = '') => (destination || '').replace(/^\/+|\/+$/g, '');

const getFileBuffer = async (file) => {
  if (file.buffer) return file.buffer;
  if (file.path) return fs.readFile(file.path);
  throw new Error('Unsupported file input for Supabase storage');
};

const supabaseProvider = {
  /**
   * Stores a file in the configured Supabase bucket.
   *
   * @param {object} file - Multer file object.
   * @param {string} destination - Relative destination path, for example: 'content' or 'avatars'.
   * @returns {Promise<string>} Relative storage path that can be persisted in the database.
   */
  async upload(file, destination = '') {
    const { bucket } = getSupabaseConfig();
    const client = getClient();

    const normalizedDestination = normalizeDestination(destination);
    const extension = path.extname(file.originalname || file.name || '').toLowerCase();
    const filename = `${file.filename || `${Date.now()}-${Math.random().toString(36).slice(2)}`}${extension}`;
    const storagePath = normalizedDestination
      ? `${normalizedDestination}/${filename}`
      : filename;

    const fileBuffer = await getFileBuffer(file);
    const { data, error } = await client.storage
      .from(bucket)
      .upload(storagePath, fileBuffer, {
        contentType: file.mimetype || 'application/octet-stream',
        upsert: true,
      });

    if (error) {
      throw new Error(`Supabase storage upload failed: ${error.message}`);
    }

    return storagePath;
  },

  /**
   * Deletes a stored file from the configured Supabase bucket.
   *
   * @param {string} storagePath - Relative storage path previously returned by upload().
   * @returns {Promise<void>}
   */
  async delete(storagePath) {
    const { bucket } = getSupabaseConfig();
    const client = getClient();
    const { error } = await client.storage.from(bucket).remove([storagePath]);
    if (error) {
      throw new Error(`Supabase storage remove failed: ${error.message}`);
    }
  },

  /**
   * Resolves a storage path to a public URL.
   *
   * @param {string} storagePath - Relative storage path previously returned by upload().
   * @returns {string} Public URL for the stored file.
   */
  resolveUrl(storagePath) {
    const { bucket } = getSupabaseConfig();
    const client = getClient();
    const { data, error } = client.storage.from(bucket).getPublicUrl(storagePath);
    if (error) {
      throw new Error(`Supabase storage getPublicUrl failed: ${error.message}`);
    }
    return data.publicUrl;
  },

  /**
   * Creates a short-lived URL for a file in the configured Supabase bucket.
   *
   * @param {string} storagePath - Relative storage path previously returned by upload().
   * @param {{ expiresInSeconds: number, downloadName?: string }} options - Signing options.
   * @returns {Promise<string>} Signed Supabase Storage URL.
   */
  async resolveSignedUrl(storagePath, { expiresInSeconds, downloadName } = {}) {
    const { bucket } = getSupabaseConfig();
    const client = getClient();
    const parsedExpiry = Number(expiresInSeconds);

    if (!Number.isInteger(parsedExpiry) || parsedExpiry <= 0) {
      throw new Error('expiresInSeconds must be a positive integer');
    }

    const options = downloadName ? { download: downloadName } : undefined;
    const bucketClient = client.storage.from(bucket);
    const { data, error } = options
      ? await bucketClient.createSignedUrl(storagePath, parsedExpiry, options)
      : await bucketClient.createSignedUrl(storagePath, parsedExpiry);

    if (error) {
      throw new Error(`Supabase storage createSignedUrl failed: ${error.message}`);
    }

    if (!data?.signedUrl) {
      throw new Error('Supabase storage createSignedUrl returned no URL');
    }

    return data.signedUrl;
  },
};

export default supabaseProvider;
