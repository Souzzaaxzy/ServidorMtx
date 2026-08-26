// Input normalization helpers. Centralized so every endpoint treats the
// nickname consistently regardless of where it enters the system.

// Nicknames: trim, strip any leading '@' symbols — the stored nickname
// NEVER carries the '@' prefix (legacy clients/users may still prepend it).
// The display form is preserved EXACTLY as typed: no lowercasing, no
// Unicode normalization, no emoji/symbol stripping.
export function normalizeNickname(nickname: string): string {
  return nickname.replace(/^@+/, '').trim();
}

// Case-insensitive lookup key used for uniqueness, login, recovery and
// profile-by-nickname resolution. The DISPLAY nickname is never derived
// from this — it only powers comparisons ("Leonardo" ≡ "LEONARDO").
export function nicknameKey(nickname: string): string {
  return normalizeNickname(nickname).toLowerCase();
}

// Nicknames allow letters (any case), numbers, accents, emojis, symbols
// and general Unicode — the only blocked characters are the ones that
// could break rendering or storage:
//   - control/format characters (incl. zero-width and bidi overrides used
//     for spoofing): \p{Cc}, \p{Cf}, \p{Cn};
//   - '<' and '>' so a nickname can never become an HTML tag (the API only
//     ever returns it as JSON text and clients render it as plain text).
// Everything is treated as TEXT end-to-end: Prisma parameterizes queries
// (no SQL injection surface) and clients must never inject it as HTML.
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cn}<>]/u;

export function isValidNickname(nickname: string): boolean {
  const normalized = normalizeNickname(nickname);
  // 3-30 characters (code points, so emojis/styled letters count as 1).
  const length = [...normalized].length;
  if (length < 3 || length > 30) return false;
  if (FORBIDDEN.test(normalized)) return false;
  return true;
}

// MATRIX ID / identifier used during account recovery — accepts a nickname
// or the raw internal id. We don't expose whether a lookup matched so the
// endpoint can't be used for user enumeration.
export function normalizeIdentifier(identifier: string): string {
  return identifier.trim();
}
