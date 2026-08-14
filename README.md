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

## Desenvolvimento local (sem Docker)

```bash
npm install --legacy-peer-deps
cp .env.example .env
# ajuste DATABASE_URL para seu Postgres local

npm run prisma:generate
npx prisma migrate deploy
npm run db:seed
npm run dev
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
