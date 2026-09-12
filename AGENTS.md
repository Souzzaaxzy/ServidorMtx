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

============================================================
MATRIX — FLUXO OBRIGATÓRIO DE TRABALHO
============================================================

COMO EU TRABALHO

Eu quero que qualquer agente que trabalhe no MATRIX siga um
processo cuidadoso, completo e organizado.

O MATRIX possui dois repositórios conectados:

APP:
https://github.com/Souzzaaxzy/MatrixApp

SERVIDOR:
https://github.com/Souzzaaxzy/ServidorMtx

O APP e o SERVIDOR NÃO devem ser tratados como projetos
independentes.

Eles fazem parte do mesmo sistema e qualquer alteração deve
considerar a comunicação entre os dois.


============================================================
FLUXO OBRIGATÓRIO
============================================================

Antes de começar qualquer alteração, seguir exatamente esta
ordem:

1. ANALISAR O PROMPT

Ler completamente o prompt/tarefa recebido.

Entender todos os requisitos, regras, limitações,
comportamentos esperados, funcionalidades novas e possíveis
impactos no sistema existente.

Não começar a programar antes de entender completamente o
prompt.


2. LER OS AGENTS.MD

Ler o AGENTS.md do APP.

Ler o AGENTS.md do SERVIDOR.

As regras dos dois arquivos são obrigatórias.


3. ANALISAR OS DOIS REPOSITÓRIOS

Antes de modificar qualquer código:

analisar completamente o APP;

analisar completamente o SERVIDOR;

analisar a arquitetura;

analisar as funcionalidades existentes;

analisar APIs;

analisar banco de dados;

analisar autenticação;

analisar realtime;

analisar comunicação APP ↔ SERVIDOR;

analisar os arquivos que serão afetados;

analisar possíveis dependências com funcionalidades antigas.


4. FAZER UMA VARREDURA COMPLETA

Não analisar somente o arquivo que aparentemente precisa ser
alterado.

Pesquisar o projeto para descobrir:

implementações existentes;

componentes reutilizáveis;

serviços existentes;

endpoints;

modelos;

schemas;

tabelas;

eventos realtime;

listeners;

rotas;

estados;

testes;

dependências;

fluxos relacionados.


O objetivo é entender como a funcionalidade realmente funciona
antes de alterá-la.


============================================================
IMPLEMENTAÇÃO
============================================================

Depois da análise completa:

começar a executar o prompt recebido.

Implementar somente o que foi solicitado e o que for
estritamente necessário para que a funcionalidade funcione
corretamente.


============================================================
REGRA PRINCIPAL — PRESERVAR O QUE JÁ EXISTE
============================================================

NÃO modificar funcionalidades antigas sem necessidade.

NÃO substituir sistemas existentes simplesmente para criar uma
nova funcionalidade.

NÃO apagar código funcional sem motivo.

NÃO criar uma segunda implementação quando já existir uma
implementação adequada.

NÃO duplicar serviços, APIs, componentes, estados ou sistemas.

NÃO alterar comportamentos antigos que não fazem parte da
tarefa.


A regra é:

ADICIONAR E INTEGRAR, NÃO DESTRUIR E REFAZER.


Se for realmente necessário modificar uma funcionalidade
existente para implementar a nova:

primeiro analisar o impacto;

preservar o comportamento anterior;

alterar somente o necessário;

testar a funcionalidade antiga;

testar a funcionalidade nova.


============================================================
APP + SERVIDOR
============================================================

Sempre verificar se a tarefa afeta:

APP;

SERVIDOR;

API;

BANCO;

REALTIME;

AUTENTICAÇÃO;

PERSISTÊNCIA.


Quando uma alteração precisar dos dois lados:

implementar os dois lados de forma sincronizada.


Nunca deixar:

APP esperando uma API inexistente;

SERVIDOR esperando dados que o APP não envia;

modelos diferentes;

contratos incompatíveis;

eventos realtime incompatíveis.


O APP e o SERVIDOR devem permanecer conectados e compatíveis.


============================================================
TESTES COMPLETOS
============================================================

Depois da implementação:

testar a funcionalidade nova;

testar as funcionalidades antigas relacionadas;

testar os fluxos existentes;

testar APP + SERVIDOR juntos;

testar persistência;

testar realtime quando aplicável;

testar erros e casos extremos.


Não testar somente o código novo.


É obrigatório verificar se a implementação nova não quebrou
funcionalidades que já existiam.


============================================================
VALIDAÇÃO
============================================================

Executar todas as ferramentas de validação disponíveis no
projeto.

APP:

flutter analyze;

flutter test;

lint, caso exista;

build.


SERVIDOR:

testes;

lint, caso exista;

build.


Corrigir TODOS os erros encontrados.

Depois das correções, executar novamente os testes necessários.


Não considerar uma tarefa concluída somente porque o projeto
compilou.


============================================================
VERIFICAÇÃO FINAL
============================================================

Antes do commit, fazer uma última revisão completa.

Verificar:

o prompt foi executado completamente;

todos os requisitos foram implementados;

APP e SERVIDOR continuam conectados;

nenhuma funcionalidade antiga foi quebrada;

nenhuma implementação duplicada foi criada;

nenhum erro ficou pendente;

testes estão passando;

build está funcionando;

persistência está funcionando;

realtime está funcionando quando aplicável.


============================================================
GIT
============================================================

Depois que tudo estiver funcionando:

fazer commit das alterações do APP;

fazer push para main;

fazer commit das alterações do SERVIDOR;

fazer push para main.


Não deixar alterações importantes somente no ambiente local.


============================================================
REGRA FINAL
============================================================

A ordem obrigatória é:

LER O PROMPT

↓

LER OS DOIS AGENTS.MD

↓

ANALISAR APP + SERVIDOR

↓

FAZER VARREDURA COMPLETA

↓

PLANEJAR

↓

IMPLEMENTAR

↓

TESTAR FUNCIONALIDADE NOVA

↓

TESTAR FUNCIONALIDADES ANTIGAS

↓

TESTAR APP + SERVIDOR

↓

CORRIGIR ERROS

↓

VALIDAR NOVAMENTE

↓

VERIFICAR SE NADA ANTIGO FOI QUEBRADO

↓

COMMIT

↓

PUSH PARA MAIN

↓

FINALIZAR


Não pular etapas.

Não pedir confirmação entre etapas.

Executar o processo de forma autônoma.


============================================================
COMO EU ESPERO QUE O AGENTE TRABALHE
============================================================

Eu prefiro alterações cuidadosas, integradas e completas.

Não quero soluções rápidas que apenas façam o código compilar.

Quero que o agente entenda primeiro como o projeto funciona,
reutilize a arquitetura existente, implemente a nova
funcionalidade sem destruir o que já existe, teste o novo e o
antigo, verifique a comunicação entre APP e SERVIDOR e somente
depois considere a tarefa concluída.

O objetivo não é apenas "fazer funcionar".

O objetivo é fazer funcionar, manter o que já funciona,
integrar corretamente os dois repositórios e entregar tudo
testado e enviado para a main.
============================================================