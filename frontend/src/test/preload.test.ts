import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../api', () => ({
  get: getMock,
}));

import { preloadRouteData } from '../routes/preload';

beforeEach(() => {
  getMock.mockClear();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => {
      if (key !== 'user') return null;
      return JSON.stringify({ id: 1, role: 'owner', branch_id: 1 });
    }),
  });
});

describe('route preloading', () => {
  it('warms dashboard data without mutating visible route state', () => {
    preloadRouteData('/dashboard');

    expect(getMock).toHaveBeenCalledWith('/menu-items/');
    expect(getMock).toHaveBeenCalledWith('/menu/deals/');
    expect(getMock).toHaveBeenCalledWith('/modifiers/');
    expect(getMock).toHaveBeenCalledWith('/settings/?branch_id=1');
  });

  it('does not preload volatile active order or kitchen endpoints', () => {
    preloadRouteData('/dashboard');

    expect(getMock).not.toHaveBeenCalledWith(expect.stringContaining('/orders/active'));
    expect(getMock).not.toHaveBeenCalledWith(expect.stringContaining('/orders/kitchen'));
  });
});
