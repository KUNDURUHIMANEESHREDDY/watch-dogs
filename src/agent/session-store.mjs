/**
 * Bounded in-memory session store for the loopback control-center gateway.
 *
 * Entries expire lazily on access/insertion. Reads refresh LRU order; callers
 * explicitly refresh the expiry when an authenticated request succeeds.
 */
export function createSessionStore({
  ttlMs = 8 * 60 * 60 * 1000,
  maxSessions = 256,
  now = Date.now,
} = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new TypeError('ttlMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) {
    throw new TypeError('maxSessions must be a positive safe integer');
  }
  if (typeof now !== 'function') {
    throw new TypeError('now must be a function');
  }

  const entries = new Map();

  function pruneExpired() {
    const current = now();
    for (const [id, expiresAt] of entries) {
      if (!Number.isFinite(expiresAt) || expiresAt <= current) entries.delete(id);
    }
  }

  return {
    get(id) {
      if (typeof id !== 'string' || id.length === 0) return undefined;
      const expiresAt = entries.get(id);
      if (expiresAt === undefined) return undefined;
      if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
        entries.delete(id);
        return undefined;
      }
      // Move a successfully accessed session to the newest position for LRU
      // eviction if the configured concurrent-session ceiling is reached.
      entries.delete(id);
      entries.set(id, expiresAt);
      return expiresAt;
    },

    set(id, expiresAt) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new TypeError('session id must be a non-empty string');
      }
      if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
        throw new TypeError('session expiry must be a finite future timestamp');
      }

      pruneExpired();
      entries.delete(id);
      while (entries.size >= maxSessions) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      entries.set(id, expiresAt);
      return entries.size;
    },

    delete(id) {
      return entries.delete(id);
    },

    clear() {
      entries.clear();
    },

    get size() {
      pruneExpired();
      return entries.size;
    },
  };
}
