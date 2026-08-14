// Input normalization helpers. Centralized so every endpoint treats
// username consistently regardless of where they enter the system.

// Usernames: lowercase, trim. Allow letters, numbers, underscores, dots, hyphens.
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function isValidUsername(username: string): boolean {
  const normalized = normalizeUsername(username);
  // 3-20 chars, start with a letter/digit, allow _ . -
  return /^[a-z0-9._-]{3,20}$/.test(normalized) && /^[a-z0-9]/.test(normalized);
}

// MATRIX ID / identifier used during account recovery — accepts a username
// or the raw internal id. We don't expose whether a lookup matched so the
// endpoint can't be used for user enumeration.
export function normalizeIdentifier(identifier: string): string {
  return identifier.trim();
}
