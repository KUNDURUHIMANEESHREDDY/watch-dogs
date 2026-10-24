import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPairRequiredError, readSnapshot } from './App';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('session expiry handling', () => {
  it('classifies the explicit 401 pairing contract without treating gateway failures as auth failures', () => {
    expect(isPairRequiredError(new Error('PAIR_REQUIRED'))).toBe(true);
    expect(isPairRequiredError(new Error('Gateway returned HTTP 503'))).toBe(false);
    expect(isPairRequiredError(new Error('Pairing code was rejected.'))).toBe(false);
    expect(isPairRequiredError('PAIR_REQUIRED')).toBe(false);
  });
});

describe('readSnapshot API contract', () => {
  it('requests the same-origin snapshot as JSON', async () => {
    const snapshot = { watchdog: { state: 'running' }, findings: [] };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => snapshot,
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(readSnapshot()).resolves.toEqual(snapshot);
    expect(fetchMock).toHaveBeenCalledWith('/api/snapshot', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
  });

  it('turns an unauthenticated response into the pairing-required contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    }));

    await expect(readSnapshot()).rejects.toThrow('PAIR_REQUIRED');
  });

  it('surfaces gateway HTTP failures instead of treating them as empty data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    }));

    await expect(readSnapshot()).rejects.toThrow('Gateway returned HTTP 503');
  });
});
