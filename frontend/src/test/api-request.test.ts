/**
 * API request(): logging, error handling, bad scenarios.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { request, get, post, resetApiClientStateForTests } from '../api/client';

vi.mock('../utils/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockFetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => (key === 'auth_token' ? 'fake-token' : null)),
  });
  mockFetch.mockReset();
  resetApiClientStateForTests();
});

describe('request', () => {
  it('adds Authorization header when token exists', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('{}'),
      headers: new Headers(),
    });
    await get('/menu-items/', { cacheTtlMs: 0, forceRefresh: true });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/menu-items/'),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer fake-token' }),
      })
    );
  });

  it('throws ApiError on 400 with backend error shape', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: () => Promise.resolve(JSON.stringify({ error: 'Bad Request', message: 'Cart is empty' })),
      headers: new Headers(),
    });
    const { ApiError } = await import('../api/errors');
    try {
      await request('/orders/checkout', { method: 'POST', body: {} });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as InstanceType<typeof ApiError>).status).toBe(400);
      expect((e as InstanceType<typeof ApiError>).body.message).toBe('Cart is empty');
    }
  });

  it('throws ApiError on 500', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve(JSON.stringify({ error: 'Internal Server Error' })),
      headers: new Headers(),
    });
    const { ApiError } = await import('../api/errors');
    await expect(get('/menu-items/', { cacheTtlMs: 0, forceRefresh: true })).rejects.toThrow(ApiError);
  });

  it('maps detail-only backend errors into ApiError body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: () => Promise.resolve(JSON.stringify({ detail: 'Only purchase orders with no received stock can be deleted' })),
      headers: new Headers(),
    });
    const { ApiError } = await import('../api/errors');
    try {
      await request('/inventory-advanced/purchase-orders/1', { method: 'DELETE' });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as InstanceType<typeof ApiError>).body.message).toBe('Only purchase orders with no received stock can be deleted');
      expect((e as InstanceType<typeof ApiError>).userMessage).toBe('Only purchase orders with no received stock can be deleted');
    }
  });

  it('throws on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Failed to fetch'));
    const { ApiError } = await import('../api/errors');
    await expect(get('/menu-items/', { cacheTtlMs: 0, forceRefresh: true })).rejects.toThrow(ApiError);
  });

  it('returns parsed JSON on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ products: [{ id: 1 }] })),
      headers: new Headers(),
    });
    const data = await get<{ products: { id: number }[] }>('/menu-items/', { cacheTtlMs: 0, forceRefresh: true });
    expect(data.products).toHaveLength(1);
    expect(data.products[0].id).toBe(1);
  });
});

describe('post', () => {
  it('sends JSON body and Content-Type', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('{}'),
      headers: new Headers(),
    });
    await post('/orders/checkout', { items: [], payment_method: 'Cash' });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ items: [], payment_method: 'Cash' }),
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      })
    );
  });

  it('adds an idempotency key to selected critical writes', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('{}'),
      headers: new Headers(),
    });
    await post('/orders/checkout', { items: [], payment_method: 'Cash' }, { idempotencyKey: 'idem-123' });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Idempotency-Key': 'idem-123' }),
      })
    );
  });

  it('does not add idempotency keys to non-critical writes', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('{}'),
      headers: new Headers(),
    });
    await post('/settings/app-events/client', { level: 'info', message: 'x' });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.not.objectContaining({ 'X-Idempotency-Key': expect.any(String) }),
      })
    );
  });

  it('dedupes duplicate in-flight critical mutations', async () => {
    let resolveResponse: (value: unknown) => void = () => {};
    mockFetch.mockReturnValueOnce(new Promise(resolve => { resolveResponse = resolve; }));

    const first = post('/stock/bulk-restock', { items: [{ ingredient_id: 1, quantity: 2 }] });
    const second = post('/stock/bulk-restock', { items: [{ quantity: 2, ingredient_id: 1 }] });

    resolveResponse({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ message: 'ok' })),
      headers: new Headers(),
    });

    await expect(Promise.all([first, second])).resolves.toEqual([{ message: 'ok' }, { message: 'ok' }]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
