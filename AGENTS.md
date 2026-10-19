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
- **start (Hostsquare)**: `bash start.sh` (root, self-contained: installs deps,
  prisma generate, build, migrate, seed-if-empty, exec server). `--install` =
  install/build only, no server. Use this as the panel Start Command; it does NOT
  require a pre-populated node_modules (unlike scripts/start.sh).
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

## Stickers — URLs públicas (o bug das figurinhas VAZIAS)
- `utils/storage.ts` exporta `publicBase()` — ÚNICA fonte da base pública:
  `STORAGE_PUBLIC_BASE_URL` → `PUBLIC_API_URL` → string vazia (o arquivo é
  salvo como caminho RELATIVO `/static/<nome>` e o app resolve contra a sua
  própria `API_BASE_URL`).
- NUNCA voltar a usar `http://localhost:<porta>`: o `LocalStorageProvider`
  fazia isso e gravava no banco uma URL que só existe dentro do servidor —
  o app baixava nada e renderizava o sticker VAZIO. `upload.service.ts`
  (imagem/áudio/vídeo) reusa o MESMO `publicBase()` para não divergir.

## Stickers — excluir pacote + favoritas
- `DELETE /api/stickers/packages/:id` (auth): só o DONO de um pacote
  importado (`authorId === userId`) pode excluir; o catálogo oficial
  responde 403. O pacote é ARQUIVADO (`active = false`), nunca apagado — as
  mensagens antigas (que referenciam os ids originais) continuam
  renderizando.
- Favoritas sobrevivem: cada figurinha favoritada do pacote é RECRIADA como
  figurinha autônoma (mesmos bytes/URL) num pacote-arquivo oculto por usuário
  (`slug = favoritos-<userId>`, `active = false`, `source = 'favorites'`) e a
  linha de `sticker_favorite` (e `sticker_recent`) aponta para a cópia. O
  endpoint devolve `preservedFavorites`.
- `chat.service.sendStickerMessage` aceita enviar quando o pacote está ATIVO
  **ou** quando a figurinha pertence ao remetente (`sticker.authorId ===
  userId`) — é isso que mantém as favoritas arquivadas ENVIÁVEIS.

## Stories (24h) — foto, vídeo e texto + curtidas e respostas
- Modelo `Story` (`type` image|video|text, `mediaUrl` — VAZIO em text story —,
  `mediaType`, `text`, `thumbnailUrl`, `caption`, `expiresAt`) +
  `StoryView` (marcador por usuário) + `StoryLike` (curtida, unique
  `userId+storyId`). Migração `20260915140000_story_text_and_likes`
  (ADD COLUMNs + nova tabela — sem rebuild no SQLite).
- `modules/stories/story.service.ts`: expiração SEMPRE no servidor
  (`STORY_TTL_MS` = 24h). `createStory` (image|video|text; text exige
  conteúdo, ≤300 chars), `listActiveStories` (só ativas; agrupa por autor,
  não-vistos primeiro; `viewed`/`liked`/`likeCount` POR VIEWER em 3 queries),
  `markStoryViewed`, `deleteStory` (só o dono), `purgeExpiredStories`,
  `toggleStoryLike` (mesma semântica do feed; upsert → nunca duplica) e
  `replyToStory`.
- **Resposta = MENSAGEM REAL:** `replyToStory` valida story ativo + que o
  autor não é quem responde e chama `getOrCreateConversation` + `sendMessage`
  com `type='story_reply'` e a referência/snapshot (`storyId`, `storyType`,
  `storyThumbUrl`, `storyPreview` em `messages`). O destinatário é SEMPRE o
  autor do Story (nunca vem do cliente); a snapshot mantém a referência
  legível depois de o Story expirar.
- Rotas (auth): `GET /api/stories` (optionalAuth; purga expirados),
  `POST /api/stories`, `POST /api/stories/:id/view` (204),
  `POST /api/stories/:id/like` (toggle), `POST /api/stories/:id/reply` (201),
  `DELETE /api/stories/:id` (204).
- Autor/mídia reutilizam EXATAMENTE o que o post usa (`AUTHOR_SELECT` +
  `nicknameCosmetics`, `/static/...`). Limpeza de arquivos só remove mídia
  que nada mais referencia.
- `tests/setup.ts` limpa `story_likes`/`story_views`/`stories`.

## Stories — limite de vídeo (2 min) validado no servidor
- `utils/storage.ts`: `MAX_STORY_VIDEO_MS` (120000) +
  `validateVideoDurationMs`. `saveVideoFile(stream, durationMs?)` valida a
  duração REAL declarada (campo multipart `durationMs` de
  `/api/uploads/video`, lido de `file.fields`), e `createStory` revalida
  `durationMs` (defesa contra replay de URL). Nunca confia só no app.

## Stickers — recentes (remoção escopada)
- `DELETE /api/stickers/:id/recent` (auth, idempotente): remove SÓ a linha de
  `sticker_recent` do usuário. Não apaga a figurinha, o pacote, o favorito
  nem o arquivo — mensagens que a referenciam continuam renderizando.
  (`removeStickerRecent` em `sticker.service.ts`.)

## Termux / Android (native, no proot)
- **Native Termux is SUPPORTED** — no proot-distro/Ubuntu/root. The DB layer
  uses no native binary at all:
  - Prisma `engineType = "client"` (Rust-free JS/WASM query compiler). The old
    Rust engine is what failed on bionic (`EM_X86_64 instead of EM_AARCH64`).
  - `node:sqlite` (built into Node >= 22.5) via `src/db/node-sqlite-adapter.ts`.
  - `node:crypto` argon2 (Node >= 24.7) via `src/utils/password.ts`; the npm
    `argon2` package is now `optionalDependencies` (no bionic prebuild).
- **Migrations on Termux**: the Prisma CLI ALWAYS downloads+executes a native
  `schema-engine` (no Android build) → `prisma migrate deploy|generate|validate`
  cannot run there ("Schema engine error" / `EM_X86_64 instead of EM_AARCH64`).
  `engineType = "client"` frees the CLIENT only, not the CLI.
  - `src/db/migrate.ts` (+ `migrate-cli.ts`) applies the same
    `prisma/migrations/*/migration.sql` via node:sqlite and writes a
    byte-identical `_prisma_migrations` (checksum = sha256 of migration.sql,
    epoch-ms timestamps, applied_steps_count=1). Verified: 148/148 schema
    objects + bookkeeping identical to real Prisma; interchangeable both ways.
  - **CRITICAL**: the runner opens SQLite with
    `enableDoubleQuotedStringLiterals: true`. Prisma's engine has DQS ON;
    node:sqlite has it OFF. Migration `20260827135123_deletion_system` relies on
    it (stores the literal string "replyToMessageId"), so without this the
    migration aborts. Do not remove that option.
  - `prisma generate` works OFFLINE if `PRISMA_SCHEMA_ENGINE_BINARY` points at
    any existing file (the engine is not executed for generate) — that is what
    `scripts/lib-prisma.sh::matrix_prisma_generate` does on Termux.
  - `PRISMA_GENERATE_NO_ENGINE=1` is NOT an option: it produces a client that
    refuses driver adapters (P2038).
  - Never use `prisma migrate reset` / `db push` here (destructive / drifts from
    the migration history).
- Entry points: `termux/termux-native.sh` (installer), `scripts/doctor.sh`
  (`npm run doctor`), `start.sh` / `npm run termux:start` (boot),
  `npm run db:migrate` / `db:migrate:status` (Termux migrations).
- **Node >= 22.5 required** (node:sqlite); >= 24.7 recommended (built-in argon2).
  `package.json` engines reflects 22.5.
- DateTime compatibility is CRITICAL: Prisma's native SQLite driver stored
  DateTime as epoch-ms INTEGER. The adapter is created with
  `{ timestampFormat: 'unixepoch-ms' }` so existing data/matrix.db files keep
  working byte-for-byte (verified against a DB written by Prisma 5).
- `src/config/prisma.ts` deliberately does NOT import `src/config/env.ts`:
  importing it would snapshot `process.env` earlier than before and break
  tests that set `DATABASE_URL` after import. The URL is resolved at CONNECT
  time from `process.env.DATABASE_URL`.
- Seeds use `createPrismaClient({ quiet: true })` to keep the client's log
  config identical to the original `new PrismaClient()` (the seed intentionally
  swallows one FK error with `.catch()`, so `log: ['error']` made noise).
- Docker/Pterodactyl/VPS use the SAME path (no native engine needed anywhere).

## Música do perfil (YouTube via yt-dlp)
- `ProfileMusic` (userId é a PK → **uma música por perfil**, garantido no banco).
  Migração `20260919000000_profile_music` (tabela nova, aditiva). O perfil
  (`GET /api/users/:nick`) embute `music` (ou `null`).
- `modules/music/profile-music.ytdlp.ts`: fala com o **YouTube Music** via
  `yt-dlp`, SEMPRE no servidor (o APK nunca fala com o YouTube, nenhuma
  credencial externa existe).
  - **Busca**: usa o filtro "songs" do YouTube Music
    (`sp=EgWKAQIIAWoKEAoQAxAEEAkQBQ==`), que é o que remove vídeo aleatório
    (clipe, react, "top 10") — exatamente o pedido. `--dump-json` traz
    título/uploader/duração/capa (medido: ~6s para 3 itens).
  - **Limpeza de título**: o YT Music NÃO manda `artist`/`track` (vêm nulos),
    então `cleanMusicTitle` tira ruído ("(Official Video)", "[HD]", "Lyrics",
    "Remastered") e `splitMusicTitle` separa música/artista. A ordem é
    ambígua: YT Music usa **"Artista – Música"**, o YT comum usa
    "Música - Artista"; o **uploader desempata** (o lado que casa com o canal
    é o artista). Sem pista, vale o padrão do YT Music.
  - **Download**: só o TRECHO (`--download-sections`), nunca a música inteira.
    Exige `ffmpeg` no host. Os bytes baixados são validados (container
    ISOBMFF/`ftyp`) — HTML de erro do YouTube não vira "áudio".
  - O binário é resolvido uma vez (`YT_DLP_PATH` → `yt-dlp` → `python3 -m
    yt_dlp`) e executado com `spawn` sem shell (a busca do usuário nunca vira
    comando). Tudo com timeout.
- Rotas (auth): `GET /api/music/profile/search?q=` (até 3 resultados),
  `GET|PUT|DELETE /api/music/profile`. O trecho é re-validado no servidor:
  **máx. 1 minuto** (`MAX_PROFILE_MUSIC_MS`), mín. 5s, início ≥ 0.
- Substituir a música apaga o arquivo ANTIGO só depois de gravar o novo
  (nunca deixa o perfil apontando para arquivo apagado). `DELETE` é
  idempotente e remove o arquivo.
- App: `ProfileMusicBar` (botão ⏯️ DESENHADO em `core/widgets/play_pause_icon.dart`
  + nome da música) logo abaixo do `#id`; `ProfileMusicPicker` no editar perfil
  (busca → 3 opções → trecho com passo de 5s até 1:00 → confirmar).
- **Falha do yt-dlp NUNCA vira "nenhuma música encontrada"**: `code !== 0` sem
  resultados lança `ytdlpFailureToApiError(stderr)`, que distingue bloqueio
  anti-bot / yt-dlp ausente / yt-dlp desatualizado / ffmpeg ausente. Antes
  tudo isso devolvia `[]` e o app dizia que não achou nada — o usuário ficava
  sem pista nenhuma.
- **Cookies do YouTube (bloqueio anti-bot)**: `YT_COOKIES` (conteúdo do
  cookies.txt, base64 ou texto cru) ou `YT_COOKIES_FILE` (caminho). O servidor
  escreve um jar temporário `chmod 600` em `data/.yt-cookies-*` por execução e
  o APAGA em seguida (um cookie jar é credencial: não pode sobrar no disco).
  É o que libera o bloqueio de IP em VPS/datacenter.
- **Runtime de JavaScript (o YouTube EXIGE um)**: o yt-dlp só habilita `deno`
  por padrão, e no Termux `deno` não é pacote padrão — enquanto o **Node está
  sempre presente** (a API roda nele). O código escolhe, nesta ordem:
  `YT_JS_RUNTIME` (env) → `deno` se existir → `node:<process.execPath>`.
  Sondamos `--help` antes: um yt-dlp antigo não conhece a flag e abortaria com
  "unrecognized arguments", quebrando o recurso inteiro.
- **Nenhuma falha é muda**: toda mensagem de erro leva `details.ytdlp` com a
  saída REAL do yt-dlp (últimas linhas), e o handler global loga o `details`.
  Sem isso um erro não classificado virava "tente novamente" e não havia como
  descobrir a causa — foi exatamente o que aconteceu no Termux.
- **Instalação das ferramentas**: `start.sh` (o boot real) instala yt-dlp +
  ffmpeg quando faltam e RECONFERE o resultado — antes isso só existia no
  instalador do Termux, então quem fazia `git pull && start.sh` nunca recebia
  as ferramentas (foi assim que o recurso ficou indisponível em produção).
  **No Termux o yt-dlp NÃO é pacote do `pkg`** (o comando falha): é
  `pip install -U yt-dlp`. O ffmpeg, esse sim, vem do `pkg`. Sem as duas
  ferramentas a API sobe normal e só a música do perfil fica indisponível.
- **Download real não foi validado neste ambiente**: o YouTube bloqueia (403
  anti-bot) IPs de datacenter para MÍDIA (a busca passa). A cadeia inteira
  (spawn → ffmpeg → validação de bytes → storage → `/static` → banco) foi
  validada com uma fonte substituta gerando m4a real.

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
