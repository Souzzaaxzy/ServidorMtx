# ServidorMtx — MATRIX Backend API

Backend do [MATRIX 💤](https://github.com/Souzzaaxzy/MatrixApp) — Node.js + Fastify + Prisma + SQLite.

## Stack
- **Node 22** + TypeScript (ESM)
- **Fastify** (HTTP API, todas as rotas em `/api`)
- **Prisma 5** + **SQLite** (arquivo local em `data/matrix.db` — sem banco externo)
- **Argon2id** para senhas, JWT para sessões

## Rodar em container (recomendado)

Requisitos no host: **Docker** + **Docker Compose**.

```bash
git clone https://github.com/Souzzaaxzy/ServidorMtx.git
cd ServidorMtx

# 1. configurar ambiente
cp .env.example .env
# edite .env: troque JWT_SECRET

# 2. subir (build + SQLite + migrations automáticas)
docker compose up -d --build

# 3. popular o banco (uma vez — opcional; apenas se quiser dados de exemplo)
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
| `JWT_SECRET` | — | **OBRIGATÓRIA. Trocar por string aleatória longa** |
| `PORT` / `SERVER_PORT` | `3000` | Porta do servidor. **Automática na Pterodactyl** — não configurar |
| `NODE_ENV` | `production` | Ambiente (opcional) |
| `CORS_ORIGIN` | `*` | Origens permitidas (liste explicitamente em prod) |
| `AI_API_KEY` | vazio | Chave do provedor de IA (Akame). Vazio = mock |
| `AI_PROVIDER` | `mock` | `mock` \| `openai` \| `anthropic` |
| `API_PORT` | `3000` | Porta exposta no host (apenas docker-compose) |
| `STORAGE_ENDPOINT` | vazio | S3/R2/MinIO. Vazio = filesystem local |

> O banco é **SQLite local** (`data/matrix.db`) — **não existe** `DATABASE_URL`
> obrigatória nem qualquer banco externo. A pasta `data/` e o arquivo são
> criados automaticamente na primeira inicialização.

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

Requisitos no host: **Node 20+** apenas. Sem Docker, sem PostgreSQL.

Um único comando provisiona **tudo** e sobe o servidor:

```bash
git clone https://github.com/Souzzaaxzy/ServidorMtx.git
cd ServidorMtx
npm start
```

O `npm start` executa `scripts/start.sh`, que faz automaticamente:

1. carrega `.env` **se existir** (opcional — nunca sobrescreve variáveis do ambiente)
2. instala as dependências (`npm install`, somente se necessário)
3. cria o diretório `data/` (armazenamento persistente do SQLite)
4. gera o cliente Prisma (somente se ausente/desatualizado)
5. valida o `JWT_SECRET` (única variável obrigatória)
6. aplica as migrations no SQLite (`data/matrix.db`, criado na 1ª vez)
7. compila o TypeScript (somente se ausente/desatualizado)
8. popula o banco (seed) — **só se o banco estiver vazio** (nunca apaga dados)
9. inicia o servidor compilado (`node dist/src/app.js`) em `0.0.0.0` na porta do ambiente

A API responde em `http://localhost:3000` (ou na `PORT` definida). O comando é
idempotente: pode ser rodado de novo a qualquer momento sem perder dados.

Para iniciar apenas o servidor (sem o bootstrap, após já ter feito o setup):
```bash
npm run start:server
```

## Desenvolvimento local

```bash
npm install
cp .env.example .env   # opcional — ajuste JWT_SECRET

npm run prisma:generate
npx prisma migrate deploy
npm run db:seed
npm run dev
```

## Pterodactyl / Bronxys (hospedagem em painel)

O servidor roda em painéis Pterodactyl **sem Docker e sem banco externo** —
o banco é **SQLite local** (`data/matrix.db`), criado automaticamente na
primeira inicialização e **nunca apagado** nos reinícios.

### Importar o egg

1. No painel: **Admin → Eggs → Import Egg** e envie
   [`pterodactyl/egg-matrix.json`](pterodactyl/egg-matrix.json).
2. Crie um **Nest** (ou use um existente) e associe o egg.
3. Crie um **Server** usando esse egg.
4. Defina `JWT_SECRET` para uma string aleatória longa
   (`openssl rand -hex 32`). **É a única variável obrigatória.**
5. Inicie o servidor. A **porta é alocada automaticamente pelo painel** —
   não configure `PORT` manualmente.

O egg faz tudo automaticamente:
- **Install script**: clona o repositório, `npm install`, gera o Prisma,
  compila o TypeScript (roda uma vez na criação do servidor).
- **Startup**: `npm start` → cria `data/`, aplica migrations no SQLite,
  popula o banco se vazio, sobe o servidor em `0.0.0.0` na porta alocada.

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
  git clone https://github.com/Souzzaaxzy/ServidorMtx.git . && npm install --include=dev && ./node_modules/.bin/prisma generate && npm run build
  ```
- **Variáveis**: `JWT_SECRET` (obrigatória), `NODE_ENV=production`
  (opcional), `CORS_ORIGIN` (opcional). A porta vem do painel
  automaticamente e o banco é SQLite local — **sem `DATABASE_URL`**.

### Lendo o diagnóstico no console

Ao iniciar, o `npm start` imprime um bloco de diagnóstico no console do
painel (visível na aba "Console") seguido do banner da aplicação:

```
[MATRIX] Iniciando API...
[MATRIX] Ambiente: production
[MATRIX] Banco: SQLite
[MATRIX] Banco: data/matrix.db
[MATRIX] Porta obtida do ambiente: XXXX
[MATRIX] Host: 0.0.0.0
[MATRIX] SQLite conectado.
[MATRIX] API iniciada com sucesso.
```

`XXXX` é a porta alocada automaticamente pelo painel. Se algo falhar, o
diagnóstico diz exatamente o que está faltando (sem expor segredos) — por
exemplo, se `JWT_SECRET` não estiver configurado:

```
[ERROR] JWT_SECRET não configurado. Configure esta variável no painel da
Pterodactyl/Bronxys (Server → Variables)
```

Verifique a saúde da API em `GET /health` (responde `200` com o status do
banco).

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
