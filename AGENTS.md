# ServidorMtx — Repository Notes

## Project
MATRIX 💤 backend — Node.js + Fastify + Prisma + **SQLite** (migrated from
PostgreSQL). Runs on Pterodactyl/Bronxys via `npm start` (self-provisions).

## Database: SQLite 
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
  SQLite). 213 tests pass (22 files).
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
- test: `npm test` (213 tests, vitest)
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

## Stickers — import via Android share
- `POST /api/stickers/import` cria um pacote DO usuário (authorId = userId)
  a partir de figuritas enviadas pelo app via `/api/uploads`. Instala o
  pacote automaticamente e deduplica por SHA-256 (`Sticker.hash`): reenviar a
  mesma imagem não duplica no escopo do usuário. Quando tudo é duplicado,
  retorna `package: null` + `skipped`.
- A coluna `hash` em `stickers` é opcional e usada só nas importações; o
  catálogo oficial não preenche hash.

## Stickers — import via Sticker.ly (código do pacote)
- `POST /api/stickers/stickerly/preview` (auth) devolve nome/autor/capa/
  figurinhas + `alreadyInstalled` SEM importar; `.../import` (auth) baixa,
  valida os BYTES (magic bytes → PNG/WebP/JPEG), guarda no /static e cria um
  pacote DO usuário com dedupe por origem e por SHA-256. Reimportar o mesmo
  código não duplica (`alreadyInstalled: true`).
- `modules/stickers/stickerly.service.ts`: fonte em `api.sticker.ly`
  (`/v3.1/stickerPack/<CODE>`), NÃO é API pública documentada — por isso a
  base é configurável (`STICKERLY_API_BASE`), há timeout curto
  (`AbortController`), limites (60 figurinhas, 5 MB/arquivo, 40 MB total) e
  o UA é o do app oficial (público, não é credencial). O servidor fala com a
  fonte; o APK NUNCA. Download com concorrência limitada (4).
- `StickerPackage` ganhou `authorId`/`source`/`sourceId`: pacotes importados
  são PRIVADOS ao dono (`listStickerPackages` filtra `authorId` null ou o do
  usuário) e `source`+`sourceId` deduplica a origem ('share' | 'stickerly').
  Migração: `20260914200000_stickerly_import`.
- O código aceita `QSXLKY` ou `https://sticker.ly/s/QSXLKY`; formato é
  validado antes de qualquer chamada externa (erro 400 amigável).

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

## Nickname cosmetics (color only)
- ONE slot: `NAME_COLOR` (hex in `assetUrl`). `NAME_EFFECT` was REMOVED
  entirely (lag): legacy catalog rows are deactivated (never deleted) and
  legacy equipped rows are cleared on boot by seed.ts; the free-equip list
  (FREE_EQUIP_TYPES in customization.service.ts) no longer includes it.
- Nickname itself is full Unicode (emoji/accents/case preserved) with
  case-insensitive uniqueness via `nicknameKey` (lowercased display form,
  migration 20260826193000). Validation in src/utils/normalize.ts blocks
  only '@', HTML brackets/quotes and control/format chars (ZWSP, bidi).
- Consolidated save: `PUT /api/customization/cosmetics` accepts
  `{ nameColorId? }` (string=equip, null=unequip, absent=untouched) in ONE
  transaction; strict allow-list rejects unknown fields.
  `GET /api/customization/cosmetics` returns the saved slot.
- Every nickname payload (feed, comments, profile, search, friends,
  notifications) embeds the OWNER's `nameColor/nameColorId` via
  `NICKNAME_COSMETICS_SELECT` + `nicknameCosmetics()` in src/utils/dto.ts.

## Group permissions (comment + group-message deletion)
- **Comments**: `deleteComment` allows ONLY the comment's author OR the post's
  author (`comment.userId === userId || comment.post.userId === userId`). Comment
  ORDER grants no extra permission — covered by
  `tests/comments.test.ts` "comment ORDER grants no extra permission".
- **Group messages**: `deleteGroupMessageForEveryone` requires the OWNER when
  deleting another member's message (a member may always delete their own); the
  broadcast `chat_message_deleted` reaches every group member. Covered by
  `tests/groups.test.ts` "group message deletion permissions".
