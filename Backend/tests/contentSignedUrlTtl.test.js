import { jest } from '@jest/globals';
import { getContentSignedUrlTtlSeconds } from '../controllers/contentController.js';

describe('Paid content signed URL TTL configuration', () => {
  const originalValue = process.env.CONTENT_SIGNED_URL_TTL_SECONDS;

  afterEach(() => {
    process.env.CONTENT_SIGNED_URL_TTL_SECONDS = originalValue;
    jest.restoreAllMocks();
  });

  it('clamps values below the supported range and logs a warning', () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.CONTENT_SIGNED_URL_TTL_SECONDS = '120';

    expect(getContentSignedUrlTtlSeconds()).toBe(300);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('using 300'));
  });

  it('clamps values above the supported range and logs a warning', () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.CONTENT_SIGNED_URL_TTL_SECONDS = '3600';

    expect(getContentSignedUrlTtlSeconds()).toBe(900);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('using 900'));
  });

  it('uses the default with a clear warning for a non-integer value', () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.CONTENT_SIGNED_URL_TTL_SECONDS = 'invalid';

    expect(getContentSignedUrlTtlSeconds()).toBe(900);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('Invalid CONTENT_SIGNED_URL_TTL_SECONDS'));
  });
});
