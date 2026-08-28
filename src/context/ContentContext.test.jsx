import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { ContentProvider, useContent } from './ContentContext';
import { useAuth } from './AuthContext';

vi.mock('../services/api.js', () => ({
  contentService: {
    getContent: vi.fn(),
    getFreeContent: vi.fn(),
  },
  BACKEND_BASE_URL: 'http://localhost:3000',
}));

vi.mock('./AuthContext.jsx', () => ({
  useAuth: vi.fn(),
}));

function TestConsumer() {
  const { content, loading } = useContent();
  return (
    <div>
      <span data-testid="loading">{loading ? 'loading' : 'done'}</span>
      <span data-testid="count">{content.length}</span>
    </div>
  );
}

function renderWithEpoch(epoch) {
  useAuth.mockReturnValue({ entitlementEpoch: epoch, user: { id: 'u1' } });
  return render(
    <ContentProvider>
      <TestConsumer />
    </ContentProvider>
  );
}

describe('ContentContext — epoch-based cache invalidation', () => {
  let getContent;

  beforeEach(async () => {
    vi.clearAllMocks();
    const api = await import('../services/api.js');
    getContent = api.contentService.getContent;
  });

  afterEach(() => {
    cleanup();
  });

  it('refetches content when entitlementEpoch changes', async () => {
    getContent
      .mockResolvedValueOnce({ data: { content: [{ id: 1 }, { id: 2 }] } })
      .mockResolvedValueOnce({ data: { content: [{ id: 3 }] } });

    useAuth.mockReturnValue({ entitlementEpoch: 0, user: { id: 'u1' } });
    const { rerender } = render(
      <ContentProvider>
        <TestConsumer />
      </ContentProvider>
    );

    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('2'));
    expect(getContent).toHaveBeenCalledTimes(1);

    useAuth.mockReturnValue({ entitlementEpoch: 1, user: { id: 'u1' } });
    rerender(
      <ContentProvider>
        <TestConsumer />
      </ContentProvider>
    );

    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('1'));
    expect(getContent).toHaveBeenCalledTimes(2);
  });

  it('does not refetch when epoch stays the same', async () => {
    getContent.mockResolvedValue({ data: { content: [{ id: 1 }] } });

    useAuth.mockReturnValue({ entitlementEpoch: 5, user: { id: 'u1' } });
    render(
      <ContentProvider>
        <TestConsumer />
      </ContentProvider>
    );

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('done'));
    expect(getContent).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 100));
    expect(getContent).toHaveBeenCalledTimes(1);
  });
});
