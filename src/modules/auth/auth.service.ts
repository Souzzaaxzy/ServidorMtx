import { prisma } from '../../config/prisma.js';
import { ApiError } from '../../utils/errors.js';
import { normalizeUsername } from '../../utils/normalize.js';
import {
  createSession,
  generateRecoveryCode,
  hashPassword,
  hashRecoveryCode,
  revokeAllUserSessions,
  rotateRefreshToken,
  revokeSession,
  signAccessToken,
  verifyPassword,
  verifyRecoveryCode,
} from '../../utils/auth.js';
import type { RegisterInput, LoginInput, RecoverInput } from './auth.schema.js';

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: ReturnType<typeof serializeUser>;
}

export interface RegisterResult extends AuthResult {
  // The plaintext recovery code is returned ONCE at registration so the
  // user can save it. It is never retrievable again.
  recoveryCode: string;
}

function serializeUser(user: {
  id: string;
  name: string;
  username: string;
  avatarUrl: string | null;
  bio: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export async function register(input: RegisterInput): Promise<RegisterResult> {
  const username = normalizeUsername(input.username);

  const existing = await prisma.user.findFirst({
    where: { username },
    select: { id: true },
  });
  if (existing) {
    // Generic message — do not reveal which field collided.
    throw ApiError.conflict('Usuário já cadastrado.');
  }

  const passwordHash = await hashPassword(input.password);
  const recoveryCode = generateRecoveryCode();
  const recoveryCodeHash = hashRecoveryCode(recoveryCode);

  const user = await prisma.user.create({
    data: {
      name: input.name.trim(),
      username,
      passwordHash,
      recoveryCodeHash,
      bio: '',
    },
  });

  const { refreshToken } = await createSession(user.id);
  const accessToken = signAccessToken(user);

  return {
    accessToken,
    refreshToken,
    user: serializeUser(user),
    recoveryCode,
  };
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const username = normalizeUsername(input.username);
  const user = await prisma.user.findUnique({ where: { username } });

  // Always perform a hash compare to keep timing roughly constant even when
  // the user does not exist, mitigating user enumeration via timing.
  const dummyHash = '$argon2id$v=19$m=19456,t=3,p=1$c2FsdHNhbHQ$invalid';
  const ok = user ? await verifyPassword(input.password, user.passwordHash) : await verifyPassword(input.password, dummyHash);

  if (!user || !ok) {
    // Generic error — never reveal whether the account exists.
    throw ApiError.unauthorized('Credenciais inválidas.');
  }

  const { refreshToken } = await createSession(user.id);
  const accessToken = signAccessToken(user);

  return {
    accessToken,
    refreshToken,
    user: serializeUser(user),
  };
}

export async function refresh(refreshToken: string): Promise<AuthResult> {
  const rotated = await rotateRefreshToken(refreshToken);
  if (!rotated) {
    throw ApiError.unauthorized('Sessão expirada.');
  }
  const user = await prisma.user.findUnique({ where: { id: rotated.userId } });
  if (!user) throw ApiError.unauthorized();

  return {
    accessToken: signAccessToken(user),
    refreshToken: rotated.refreshToken,
    user: serializeUser(user),
  };
}

export async function logout(refreshToken: string): Promise<void> {
  await revokeSession(refreshToken);
}

export async function getCurrentUser(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw ApiError.unauthorized();
  return serializeUser(user);
}

// ── Account recovery ────────────────────────────────────────────
// Recovers an account using a username/MATRIX ID + recovery code + new
// password. Brute-force protection (attempt tracking + lockout) is enforced
// by the `checkRecoveryAttempt`/`recordRecoveryFailure` helpers wired into
// the route. This function deliberately performs a constant-time-ish hash
// comparison even when the user is not found, and never reveals whether the
// identifier exists.

export async function recoverAccount(
  input: RecoverInput,
  { isLocked, recordFailure }: { isLocked: () => boolean; recordFailure: () => void },
): Promise<void> {
  if (isLocked()) {
    throw ApiError.tooManyRecoveryAttempts();
  }

  // Normalize the identifier to a username form for lookup.
  const username = normalizeUsername(input.identifier);
  const user = await prisma.user.findUnique({ where: { username } });

  // Always run a verification against a dummy hash so timing does not leak
  // whether the identifier exists.
  const dummyHash = hashRecoveryCode('000000000000');
  const codeOk = user ? verifyRecoveryCode(input.recoveryCode, user.recoveryCodeHash) : verifyRecoveryCode(input.recoveryCode, dummyHash);

  if (!user || !codeOk) {
    recordFailure();
    // Generic message — do not reveal whether the user exists or which
    // field was wrong.
    throw ApiError.unauthorized('Dados de recuperação inválidos.');
  }

  // Success: rotate the password, revoke all existing sessions, and issue
  // a fresh recovery code hash is kept as-is (the original is not rotated
  // so the user can continue using the same code; rotation is a future
  // enhancement). All active sessions are invalidated for security.
  const passwordHash = await hashPassword(input.newPassword);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash },
  });
  await revokeAllUserSessions(user.id);
}
