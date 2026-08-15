# ServidorMtx — MATRIX Backend API

Backend do [MATRIX 💤](https://github.com/Souzzaaxzy/MatrixApp) — Node.js + Fastify + Prisma + PostgreSQL.

## Stack
- **Node 22** + TypeScript (ESM)
- **Fastify** (HTTP API, todas as rotas em `/api`)
- **Prisma 5** + **PostgreSQL 17**
- **Argon2id** para senhas, JWT para sessões

## Rodar em container (recomendado)

Requisitos no host: **Docker** + **Docker Compose**.

```bash
git clone https://github.com/Souzzaaxzy/ServidorMtx.git
cd ServidorMtx

# 1. configurar ambiente
cp .env.example .env
# edite .env: troque JWT_SECRET e POSTGRES_PASSWORD

# 2. subir (build + Postgres + migrations automáticas)
docker compose up -d --build

# 3. popular o banco (uma vez)
docker compose exec api npx tsx prisma/seed.ts
```

A API responde em `http://localhost:3000`.

Verifique:
```bash
curl http://localhost:3000/api/config
```

## Variáveis de ambiente (.env)

| Variável | Default | Descrição |
|----------|---------|-----------|
| `POSTGRES_USER` | `matrix` | Usuário do banco |
| `POSTGRES_PASSWORD` | `matrix` | **Trocar em produção** |
| `POSTGRES_DB` | `matrix` | Nome do banco |
| `DATABASE_URL` | `postgresql://matrix:matrix@db:5432/matrix` | Connection string (host `db` no compose) |
| `JWT_SECRET` | `change-me…` | **Trocar por string aleatória longa** |
| `CORS_ORIGIN` | `*` | Origens permitidas (liste explicitamente em prod) |
| `AI_API_KEY` | vazio | Chave do provedor de IA (Akame). Vazio = mock |
| `AI_PROVIDER` | `mock` | `mock` \| `openai` \| `anthropic` |
| `API_PORT` | `3000` | Porta exposta no host |
| `STORAGE_ENDPOINT` | vazio | S3/R2/MinIO. Vazio = filesystem local |

## Endpoints principais

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/auth/register` | Cadastro (username + senha) — retorna recovery code |
| POST | `/api/auth/login` | Login (username + senha) |
| POST | `/api/auth/recover` | Recuperação (username + código + nova senha) |
| POST | `/api/auth/refresh` | Renovar access token |
| GET | `/api/auth/me` | Usuário atual |
| GET | `/api/posts` | Feed |
| POST | `/api/posts` | Criar post |
| GET | `/api/config` | Configuração dinâmica do app |
| GET | `/api/gamification/me` | Status do usuário (auth) |
| GET | `/api/gamification/ranking` | Top usuários por XP |
| GET | `/api/customization/catalog` | Catálogo de itens |
| GET | `/api/customization/inventory` | Inventário (auth) |
| POST | `/api/uploads` | Upload de mídia (auth, multipart) |
| POST | `/api/akame/chat` | Chat com a IA Akame (auth) |

## Rodar no host com `npm start` (tudo automático)

Requisitos no host: **Node 20+**, **Docker** (para o Postgres; se já tiver um
Postgres local, o Docker é opcional).

Um único comando provisiona **tudo** e sobe o servidor:

```bash
git clone https://github.com/Souzzaaxzy/ServidorMtx.git
cd ServidorMtx
npm start
```

O `npm start` executa `scripts/start.sh`, que faz automaticamente:

1. cria `.env` a partir do `.env.example` (se ainda não existir)
2. instala as dependências (`npm install`)
3. sobe um PostgreSQL em container via Docker Compose (se o Docker estiver disponível)
4. gera o cliente Prisma
5. aplica as migrations
6. compila o TypeScript
7. popula o banco (seed) — **só se o banco estiver vazio** (nunca apaga dados)
8. inicia o servidor compilado (`node dist/src/app.js`)

A API responde em `http://localhost:3000`. O comando é idempotente: pode ser
rodado de novo a qualquer momento sem perder dados.

> Se você não usa Docker, basta apontar `DATABASE_URL` no `.env` para o seu
> Postgres local (use `127.0.0.1` e não `localhost` para evitar problema de
> resolução IPv6).

Para iniciar apenas o servidor (sem o bootstrap, após já ter feito o setup):
```bash
npm run start:server
```

## Desenvolvimento local (sem Docker)

```bash
npm install --legacy-peer-deps
cp .env.example .env
# ajuste DATABASE_URL para seu Postgres local (use 127.0.0.1)

npm run prisma:generate
npx prisma migrate deploy
npm run db:seed
npm run dev
```

## Pterodactyl (hospedagem em painel)

O servidor roda em painéis Pterodactyl **sem Docker** — o banco PostgreSQL é
fornecido pelo próprio painel (ou externamente), e `npm start` usa a
`DATABASE_URL` configurada nas variáveis do servidor.

### Importar o egg

1. No painel: **Admin → Eggs → Import Egg** e envie
   [`pterodactyl/egg-matrix.json`](pterodactyl/egg-matrix.json).
2. Crie um **Nest** (ou use um existente) e associe o egg.
3. Crie um **Server** usando esse egg.
4. Crie um **Database** no painel (PostgreSQL) e atribua ao servidor — o
   painel gera a `DATABASE_URL` automaticamente, ou preencha a variável
   `Database URL` manualmente com uma string externa.
5. Defina `JWT Secret` para uma string aleatória longa.

O egg faz tudo automaticamente:
- **Install script**: clona o repositório, `npm install`, gera o Prisma,
  compila o TypeScript (roda uma vez na criação do servidor).
- **Startup**: `npm start` → aplica migrations, popula o banco se vazio,
  sobe o servidor na `SERVER_PORT` do painel.

### Egg genérico (alternativa)

Se preferir usar um egg Node.js genérico já existente:

- **Startup command** (clona o repo se o container estiver vazio, depois sobe):
  ```
  bash -c 'if [ ! -f package.json ]; then git clone --depth 1 https://github.com/Souzzaaxzy/ServidorMtx.git /tmp/mx && cp -a /tmp/mx/. . && rm -rf /tmp/mx; fi && npm start'
  ```
  > O `npm start` sozinho falha com "no such file package.json" quando o
  > container está vazio. O one-liner acima resolve isso clonando antes.
- **Install script** (opcional, acelera o primeiro start):
  ```
  git clone https://github.com/Souzzaaxzy/ServidorMtx.git . && npm install --legacy-peer-deps && ./node_modules/.bin/prisma generate && npm run build
  ```
- **Variáveis**: `DATABASE_URL` (obrigatória), `JWT_SECRET`, `SERVER_PORT`
  (automática do painel), `NODE_ENV=production`.

> Importante: no Pterodactyl **não há Docker dentro do container**, então o
> Postgres deve ser externo (criado pelo painel). O `npm start` detecta a
> ausência do Docker e usa o banco via `DATABASE_URL` automaticamente.

### Lendo o diagnóstico no console

Ao iniciar, o `npm start` imprime um bloco de diagnóstico no console do
painel (visível na aba "Console"). Ele mostra: versões do Node/npm/git,
se o `package.json` existe, todas as variáveis de ambiente (senhas
mascaradas), o tipo de banco esperado pelo Prisma, e um teste de
conectividade TCP com o banco. Se algo falhar, esse bloco diz exatamente o
que está faltando — por exemplo, se o painel forneceu um banco MySQL em vez
de PostgreSQL, aparece:

```
⚠ BANCO MySQL DETECTADO — o MATRIX API precisa de PostgreSQL!
```

## Testes

```bash
npm test          # 64 testes (vitest)
npm run typecheck
```

## Estrutura

```
src/
├── config/         env, prisma client, logger
├── gamification/   xp.service (ledger), coin.service (ledger)
├── middleware/     authenticate (JWT + requireRole RBAC)
├── modules/
│   ├── auth/           username-only, Argon2id, recovery code
│   ├── posts/ comments/ likes/ users/ search/ uploads/
│   ├── gamification/   XP + Matrix Coins (server-controlled)
│   ├── customization/  personalização dinâmica + inventário
│   ├── music/          tracks/playlists/votes (sem pirataria)
│   ├── games/          GameSession/GameResult (recompensas validadas)
│   ├── calls/          contratos de salas (sem mídia ainda)
│   ├── akame/          AIProvider abstraction (chave só no server)
│   ├── config/         GET /api/config
│   └── admin/          painel staff (RBAC)
└── utils/          auth, recovery_guard (brute-force), errors, dto
```

## Segurança
- Senhas: **Argon2id** (nunca em texto puro)
- Recovery code: 12 dígitos, só o **hash** é armazenado
- Brute-force guard: 5 tentativas / bloqueio 15min (não revela se usuário existe)
- JWT access + refresh token opaco (hash armazenado, revogável)
- RBAC: USER / MODERATOR / ADMIN / OWNER
- API key da IA **somente no servidor** (nunca no APK)
- Secrets por variáveis de ambiente (nunca no código/git)
