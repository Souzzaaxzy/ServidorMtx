// In-memory brute-force guard for account recovery.
//
// Recovery codes have low entropy (12 numeric digits), so we cap how many
// attempts a given identifier/IP may make within a window and temporarily
// lock them out once the threshold is exceeded. The store is process-local;
// in a multi-instance deployment this should be backed by Redis, but the
// API surface here stays the same.

interface AttemptRecord {
  count: number;
  lockedUntil: number;
}

const MAX_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const WINDOW_MS = 15 * 60 * 1000;

const store = new Map<string, AttemptRecord>();

function key(identifier: string, ip: string): string {
  return `${normalize(identifier)}:${ip}`;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function get(key: string): AttemptRecord {
  const now = Date.now();
  let record = store.get(key);
  if (!record) {
    record = { count: 0, lockedUntil: 0 };
    store.set(key, record);
  }
  // Reset the window once it has elapsed.
  if (record.lockedUntil && record.lockedUntil < now) {
    record.count = 0;
    record.lockedUntil = 0;
  }
  return record;
}

export function isLocked(identifier: string, ip: string): boolean {
  const record = get(key(identifier, ip));
  return record.lockedUntil > Date.now();
}

export function recordFailure(identifier: string, ip: string): void {
  const k = key(identifier, ip);
  const record = get(k);
  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) {
    record.lockedUntil = Date.now() + LOCK_DURATION_MS;
  }
  // Best-effort cleanup of stale entries so the map doesn't grow unbounded.
  if (store.size > 10_000) {
    pruneStale();
  }
}

export function reset(identifier: string, ip: string): void {
  store.delete(key(identifier, ip));
}

// Exposed for tests.
export function _resetAll(): void {
  store.clear();
}

export const RECOVERY_GUARD_CONFIG = {
  maxAttempts: MAX_ATTEMPTS,
  lockDurationMs: LOCK_DURATION_MS,
  windowMs: WINDOW_MS,
} as const;

function pruneStale(): void {
  const now = Date.now();
  for (const [k, record] of store) {
    if (record.lockedUntil && record.lockedUntil < now && record.count >= MAX_ATTEMPTS) {
      // Keep locked entries until they naturally expire.
      continue;
    }
    store.delete(k);
  }
}
