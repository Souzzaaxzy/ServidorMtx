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
- Server binds `0.0.0.0:port` (app.ts). PORT wins; SERVER_PORT (Pterodactyl)
  fallback; 3000 last resort (dev only). Port is NEVER hardcoded/user-set.
- `JWT_SECRET` resolution order: process.env (panel/.env) → persisted file
  `data/.jwt_secret` (auto-generated ONCE by start.sh, chmod 600, gitignored)
  → clear error. Never hardcode a secret; never regenerate per boot (that
  would invalidate tokens). `src/config/env.ts` also reads `data/.jwt_secret`
  so `npm run start:server` (no start.sh) works. Dev/test use an insecure
  placeholder.
- Optional vars: NODE_ENV, CORS_ORIGIN, AI_API_KEY/AI_PROVIDER (absent key →
  Akame mock provider; API keeps running).
- Startup banner: app.ts prints `[MATRIX] ...` lines (ambiente/banco/porta/host/
  SQLite conectado/iniciada). `GET /health` → 200 `{status, service, database}`.
- SQLite DB file must NEVER be committed (.gitignore: `data/*.db*`).
- `argon2` (native) is required for password hashing — verify it loads on the host.

## Public URL (app connection)
- The code NEVER creates a public URL. The panel exposes the allocated port
  on the node's public IP/host (server page → allocation). `PUBLIC_API_URL`
  (env.ts, optional/informational) holds that real address; the startup
  banner prints it + the `/health` link, or panel instructions when absent.
- HTTPS only if the panel provides a domain/proxy with valid SSL — never
  invent `https://` for a raw IP:port. No tunnels (a trycloudflare URL was
  previously used and removed — see CONEXAO_APP.md).
- MatrixApp reads the same URL via `API_BASE_URL` (dart-define / CI secret).

## Git identity
openhands / openhands@all-hands.dev

## Nickname cosmetics (colors + effects)
- Two INDEPENDENT slots: `NAME_COLOR` (hex in `assetUrl`) and `NAME_EFFECT`
  (render contract in `items.config` as JSON string — SQLite has no Json).
- Effects catalog: `prisma/name-effects.ts` (88 effects, 9 categories),
  upserted on every boot by `syncCatalog()` in seed.ts. Both types are
  free (no ownership) — see FREE_EQUIP_TYPES in customization.service.ts.
- Consolidated save: `PUT /api/customization/cosmetics` accepts
  `{ nameColorId?, nameEffectId? }` (string=equip, null=unequip, absent=
  untouched) in ONE transaction; strict allow-list rejects CSS/JS/unknown
  fields. `GET /api/customization/cosmetics` returns the saved pair.
- Every nickname payload (feed, comments, profile, search, friends,
  notifications) embeds the OWNER's `nameColor/nameColorId/nameEffectId/
  nameEffect` via `NICKNAME_COSMETICS_SELECT` + `nicknameCosmetics()` in
  src/utils/dto.ts.
