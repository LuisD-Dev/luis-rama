import { jest } from '@jest/globals';

const createSignedUrl = jest.fn();
const from = jest.fn(() => ({ createSignedUrl }));
const createClient = jest.fn(() => ({ storage: { from } }));

jest.unstable_mockModule('@supabase/supabase-js', () => ({ createClient }));

const { default: supabaseProvider } = await import('../storage/supabaseProvider.js');

describe('Supabase storage signed URLs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_URL = 'https://project.supabase.co';
    process.env.SUPABASE_SERVICE_KEY = 'service-role-key';
    process.env.SUPABASE_BUCKET = 'paid-content';
  });

  it('uses createSignedUrl with TTL and an optional download name', async () => {
    createSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://project.supabase.co/signed/lesson' },
      error: null,
    });

    const result = await supabaseProvider.resolveSignedUrl('content/lesson.pdf', {
      expiresInSeconds: 600,
      downloadName: 'lesson.pdf',
    });

    expect(from).toHaveBeenCalledWith('paid-content');
    expect(createSignedUrl).toHaveBeenCalledWith(
      'content/lesson.pdf',
      600,
      { download: 'lesson.pdf' }
    );
    expect(result).toBe('https://project.supabase.co/signed/lesson');
  });

  it('surfaces Supabase signing failures', async () => {
    createSignedUrl.mockResolvedValue({
      data: null,
      error: { message: 'object not found' },
    });

    await expect(supabaseProvider.resolveSignedUrl('content/missing.pdf', {
      expiresInSeconds: 900,
    })).rejects.toThrow('Supabase storage createSignedUrl failed: object not found');
  });
});
