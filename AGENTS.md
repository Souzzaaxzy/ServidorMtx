# ServidorMtx — Repository Notes

## Project
MATRIX 💤 backend — Node.js + Fastify + Prisma + **SQLite** (migrated from
PostgreSQL). Runs on Pterodactyl/Bronxys via `npm start` (self-provisions).

## Database: SQLite (Phase 4 migration)
- **Provider**: `sqlite` in `prisma/schema.prisma`. No PostgreSQL/psql/external DB.
- **DB file**: `data/matrix.db` (gitignored, created on first boot, NEVER deleted).
- **DATABASE_URL**: OPTIONAL. Defaults to an **absolute** path
  `file:<cwd>/data/matrix.db` (start.sh) / `file:/app/data/matrix.db` (container).
  Use ABSOLUTE paths — Prisma resolves `file:` relative to `schema.prisma`, which
  differs between the CLI (`prisma/`), dev client (`src/generated`), and compiled
  client (`dist/src/generated`). Absolute paths remove all ambiguity.
- **Enums**: SQLite has no enums → all 8 Prisma enums converted to `String` fields.
  App-level enums live in `src/types/enums.ts` (import from there, NOT the
  generated client). DB returns `string`; cast `as UserRole` for lookups.
- **Json fields**: SQLite has no Json → `GameSession.metadata` and
  `AppConfig.value` are `String`. Serialize with `JSON.stringify`/`parseValue`.
- **Migrations**: single baseline `prisma/migrations/<ts>_init/`. Old PG
  migrations removed. `migration_lock.toml` provider = `sqlite`.
- **Tests**: `tests/setup.ts` uses SQLite `data/test.db` (absolute path). Cleanup
  between tests = `DELETE FROM` with `PRAGMA foreign_keys = OFF` (no TRUNCATE in
  SQLite). 64 tests pass.
- **search.service.ts**: no `mode: 'insensitive'` (SQLite LIKE is case-insensitive).

## Environment
- Node 22, npm (10+ or 12). JDK/Flutter not needed here (Flutter is `MatrixApp`).
- `npm install` is clean (no ERESOLVE): ESLint 9 ecosystem — `@eslint/js@^9.17.0`,
  `eslint@^9.17.0`, `typescript-eslint@^8.67.0`. (Was `@eslint/js@^10.0.1` —
  fixed in commit 2e6d015.)

## Commands
- deps: `npm install`
- generate client: `npx prisma generate` (or `./node_modules/.bin/prisma generate`)
- build: `npm run build` → `dist/src/app.js`
- test: `npm test` (64 tests, vitest)
- lint: `npm run lint`
- dev: `npm run dev`
- **start (production)**: `npm start` → `scripts/start.sh` (self-provisions:
  diagnostics → .env optional → deps → data/ dir → SQLite → prisma generate →
  validate → migrate deploy → build → seed (if empty) → `exec node dist/src/app.js`)
- docker: `docker compose up -d --build` (no DB service, SQLite in `matrixdata` volume)

## Architecture
- `src/config/` — env.ts, prisma.ts (shared PrismaClient), AppState.
- `src/modules/` — auth, posts, comments, likes, users, search, uploads,
  gamification (xp, coin), customization, music, games, calls, akame, config, admin.
- `src/middleware/authenticate.ts` — JWT + `requireRole` (RBAC: USER/MODERATOR/
  ADMIN/OWNER). Role from DB is `string`; cast `as UserRole` with `?? ROLE_RANK.USER`.
- `src/types/enums.ts` — app-level const enums (UserRole, ItemType, XpReason, etc.).
- `prisma/seed.ts` — seeds levels/items/games/users/posts; skips if users exist.
- All HTTP in data layer; RBAC enforced server-side. AI_API_KEY server-only.

## Conventions / gotchas
- `npm start` never depends on `.env` or `.env.example` in production — panel
  injects vars via process.env. `.env` is dev-only convenience (loaded with
  no-override so panel vars win).
- start.sh `npm install --include=dev` ensures devDeps (tsc, typescript) install
  even when NODE_ENV=production. NOT --force / --legacy-peer-deps.
- Server binds `0.0.0.0:port` (app.ts). PORT wins; SERVER_PORT (Pterodactyl) fallback.
- SQLite DB file must NEVER be committed (.gitignore: `data/*.db*`).
- `argon2` (native) is required for password hashing — verify it loads on the host.

## Git identity
openhands / openhands@all-hands.dev
