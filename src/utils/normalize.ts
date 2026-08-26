// Input normalization helpers. Centralized so every endpoint treats the
// nickname consistently regardless of where it enters the system.

// Nicknames: lowercase, trim. Any leading '@' symbols are stripped — the
// stored nickname NEVER carries the '@' prefix (legacy clients/users may
// still prepend it).
export function normalizeNickname(nickname: string): string {
  return nickname.replace(/^@+/, '').trim().toLowerCase();
}

export function isValidNickname(nickname: string): boolean {
  const normalized = normalizeNickname(nickname);
  // 3-30 chars, start with a letter/digit, allow _ . - and spaces.
  return /^[a-z0-9._ -]{3,30}$/.test(normalized) && /^[a-z0-9]/.test(normalized);
}

// MATRIX ID / identifier used during account recovery — accepts a nickname
// or the raw internal id. We don't expose whether a lookup matched so the
// endpoint can't be used for user enumeration.
export function normalizeIdentifier(identifier: string): string {
  return identifier.trim();
}
