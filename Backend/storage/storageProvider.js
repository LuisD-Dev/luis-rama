/**
 * Common storage provider interface used by the application.
 *
 * Each provider must implement:
 * - upload(file, destination): stores a file and returns a persisted relative path.
 * - delete(path): removes a previously stored file.
 * - resolveUrl(path): converts a stored path into a URL that the client can use.
 * - resolveSignedUrl(path, options): creates a short-lived URL for protected content.
 */

/**
 * Uploads a file to the configured storage backend.
 *
 * @param {object} file - File object from Multer or another upload middleware.
 * @param {string} destination - Relative destination path (for example: 'content' or 'avatars').
 * @returns {Promise<string>} Relative storage path that can be saved in the database.
 */
export const upload = async (file, destination) => {
  throw new Error('Storage provider must implement upload()');
};

/**
 * Deletes a stored file by its relative storage path.
 *
 * @param {string} pathToDelete - Relative path returned by upload().
 * @returns {Promise<void>}
 */
export const deleteFile = async (pathToDelete) => {
  throw new Error('Storage provider must implement delete()');
};

/**
 * Resolves the storage path to a client-accessible URL.
 *
 * @param {string} pathToResolve - Relative path returned by upload().
 * @returns {Promise<string>|string} Public URL or URL-like path.
 */
export const resolveUrl = (pathToResolve) => {
  throw new Error('Storage provider must implement resolveUrl()');
};

/**
 * Resolves the storage path to a time-limited client-accessible URL.
 *
 * @param {string} pathToResolve - Relative path returned by upload().
 * @param {{ expiresInSeconds: number, downloadName?: string }} options - Signing options.
 * @returns {Promise<string>|string} A URL that expires after the requested TTL.
 */
export const resolveSignedUrl = (pathToResolve, options) => {
  throw new Error('Storage provider must implement resolveSignedUrl()');
};
