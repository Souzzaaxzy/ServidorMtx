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
| `YT_COOKIES` | vazio | Cookie do YouTube em base64 (anti-bot). Opcional — veja abaixo |

> O banco é **SQLite local** (`data/matrix.db`) — **não existe** `DATABASE_URL`
> obrigatória nem qualquer banco externo. A pasta `data/` e o arquivo são
> criados automaticamente na primeira inicialização.

### Cookies do YouTube (música do perfil)

A busca de música usa o yt-dlp. Em IP de VPS/datacenter o YouTube costuma
bloquear com "Sign in to confirm you're not a bot". A solução é dar ao servidor
um `cookies.txt` exportado de um navegador **logado no YouTube** (extensão que
gere o formato Netscape, ex.: "Get cookies.txt LOCALLY").

**Caminho mais simples — sem configurar nada:** copie o arquivo para
`data/cookies.txt`:

```bash
cp cookies.txt /caminho/do/projeto/data/cookies.txt
```

O servidor encontra o arquivo sozinho, restringe a permissão para `600` no
boot e o repassa ao yt-dlp (numa cópia temporária — o yt-dlp reescreve o
arquivo de cookies ao sair, então o seu arquivo nunca é modificado). `data/` é
o mesmo diretório persistente do `matrix.db`, então o arquivo sobrevive a
reinícios e redeploys.

Alternativas (usadas só se o drop-in não existir): `YT_COOKIES` (conteúdo em
base64 ou texto cru) e `YT_COOKIES_FILE` (caminho). O `doctor` e o banner de
boot mostram qual fonte está ativa — **sem nunca imprimir o valor**, que é
credencial. Trate esse arquivo como senha: use uma conta descartável e troque
o cookie se ele vazar.

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

## Hostsquare (hospedagem em painel — script único)

A Hostsquare é uma hospedagem de painel "chata": ela só deixa você definir um
**Start Command** e não roda `npm install`/build sozinha. Por isso existe o
**`start.sh` na raiz do projeto**, que faz TUDO em um único comando
(instala dependências, gera o Prisma, compila, cria/migra o SQLite, popula se
vazio e sobe o servidor).

No painel da Hostsquare:

- **Start Command**: `bash start.sh`
- **Install / Build Command** (se o painel pedir): `bash start.sh --install`

Na primeira vez (ou se o painel tiver apenas o botão de start), o
`bash start.sh` já resolve tudo sozinho — ele é idempotente e pula o que já
está pronto nos reinícios.

Variáveis (aba Variables/Environment):

| Variável | Obrigatória | Observação |
|----------|-------------|------------|
| `JWT_SECRET` | não* | *Se ausente, o script gera um segredo persistente em `data/.jwt_secret`. Recomendado definir no painel (`openssl rand -hex 32`). |
| `PORT` | não | Preenchida automaticamente pelo painel. O script também aceita `SERVER_PORT`. |
| `NODE_ENV` | não | Use `production`. |
| `CORS_ORIGIN` | não | Default `*`. |

O banco é SQLite local (`data/matrix.db`) — **não** configure `DATABASE_URL`
nem PostgreSQL. `data/` precisa ser um diretório **persistente** (fora do
deploy) para os dados sobreviverem a reinícios.

Diferença em relação ao `scripts/start.sh` (Pterodactyl/Bronxys): aquele é o
script do `npm start` e depende de `node_modules` já instalado no volume; o
`start.sh` da raiz é autossuficiente e é o ponto de entrada para a Hostsquare.

## Termux (Android) — suporte nativo, sem proot/Ubuntu

A API roda **direto no Termux**, sem root, sem Ubuntu e sem `proot-distro`.
Isso é possível porque o acesso ao banco não depende de nenhum binário nativo:

| Componente | O que é usado | Por que funciona no Android |
|------------|---------------|-----------------------------|
| ORM (runtime) | Prisma 6.19 com `engineType = "client"` | O query compiler roda em **JS/WASM** — não existe binário Rust para carregar |
| Driver | `node:sqlite` (embutido no Node) | Já vem no Node ≥ 22.5, sem compilar nada |
| Hash de senha | `node:crypto` argon2 (Node ≥ 24.7) | Embutido; o pacote npm `argon2` virou **opcional** |
| Migrations | `src/db/migrate.ts` (runner próprio) | O **Prisma CLI não roda no Android** (veja abaixo) |

### Por que as migrations usam um runner próprio

`engineType = "client"` deixa o **Client** livre de binários nativos, mas **não** o
**Prisma CLI**: `prisma migrate deploy`, `prisma generate` e `prisma validate`
sempre baixam e executam um binário nativo `schema-engine`, e o Prisma **não
publica build para Android/bionic**. No Termux isso falha com:

```
Prisma detected unknown OS "android" … Defaulting to "linux".
Error: Schema engine error
… is for EM_X86_64 (62) instead of EM_AARCH64 (183)
```

A solução tem duas partes, ambas verificadas:

1. **Gerar o client** funciona offline: apontando `PRISMA_SCHEMA_ENGINE_BINARY`
   para qualquer arquivo existente, o `prisma generate` não executa o engine e
   ainda emite o client WASM completo. O `start.sh` faz isso automaticamente no
   Termux.
2. **Aplicar migrations** usa `src/db/migrate.ts`, que executa os mesmos
   `prisma/migrations/*/migration.sql` via `node:sqlite` e grava a tabela
   `_prisma_migrations` **idêntica** à do Prisma. Verificado: 148/148 objetos de
   schema e todo o histórico de migrations batem com `prisma migrate deploy`, e
   os dois são intercambiáveis nos dois sentidos.

Em Linux/Windows/Docker nada muda: o `start.sh` detecta o ambiente e usa o
`prisma migrate deploy` convencional.

### Requisitos

- Termux atualizado e **Node ≥ 24.7** (recomendado) ou ≥ 22.5:

```bash
pkg update && pkg install nodejs-lts
node -v   # precisa ser >= 24.7
```

### Instalação (um comando)

```bash
pkg install git -y
git clone --depth 1 https://github.com/Souzzaaxzy/ServidorMtx.git
cd ServidorMtx
bash termux/termux-native.sh
```

O instalador confere o ambiente, instala os pacotes do Termux
(`git`, `openssl`, `python`, `make`, `clang`), instala as dependências, gera o
cliente Prisma, compila e aplica as migrations. Se o repositório já estiver
clonado, use `bash termux/termux-native.sh --no-clone`.

### Iniciar / verificar

```bash
bash start.sh          # ou: npm run termux:start
npm run doctor         # diagnóstico do ambiente (não altera nada)
```

A API responde em `http://127.0.0.1:3000` (ou na `PORT` definida) —
`curl http://127.0.0.1:3000/health`.

### Atualizar uma instalação existente

```bash
cd ServidorMtx
git pull
bash termux/termux-native.sh --no-clone   # reinstala/atualiza e migra
bash start.sh
```

O banco (`data/matrix.db`) **nunca é apagado** e as migrations são
não destrutivas.

### Backup e restauração do banco

```bash
# Backup (seguro mesmo com a API rodando — usa o backup consistente do SQLite)
mkdir -p ~/matrix-backup
node -e "require('node:sqlite').backup(require('node:sqlite').DatabaseSync ? 'data/matrix.db' : '', '')" 2>/dev/null || cp data/matrix.db ~/matrix-backup/matrix-$(date +%F-%H%M).db
# Ou, com a API parada:
cp data/matrix.db ~/matrix-backup/matrix-$(date +%F-%H%M).db

# Restauração (com a API parada)
cp ~/matrix-backup/matrix-AAAAMMDD-HHMM.db data/matrix.db
```

### Migrações

```bash
# Termux (sem Prisma CLI):
npm run db:migrate            # aplica pendentes (não destrutivo)
npm run db:migrate:status     # mostra aplicadas/pendentes

# Linux/Docker (fluxo convencional):
npx prisma migrate deploy
npm run prisma:generate
```

### Variáveis de ambiente

Igual ao Linux: `JWT_SECRET` (se ausente, o `start.sh` gera um segredo
persistente em `data/.jwt_secret`), `PORT`/`SERVER_PORT`, `NODE_ENV`,
`CORS_ORIGIN`, `AI_API_KEY`/`AI_PROVIDER`. O banco é SQLite local —
`DATABASE_URL` é opcional.

### Diferenças em relação ao Linux convencional

- **Node mínimo 22.5** (por causa do `node:sqlite`); no Termux, ≥ 24.7 também
  dispensa o `argon2` nativo.
- O pacote npm `argon2` é **opcional** (`optionalDependencies`). No Termux ele
  normalmente não compila — e não é necessário, pois o argon2 embutido é usado.
  O `npm install` foi ajustado para tolerar isso (`--omit=optional` como
  fallback).
- Não há `systemd`/daemon: mantenha o processo rodando com `tmux`/`termux-wake-lock`
  se quiser deixá-lo ativo em segundo plano.
- O Android pode encerrar processos em segundo plano: desative a otimização de
  bateria para o Termux (`termux-wake-lock`) para o servidor não cair.

### Solução de problemas

| Sintoma | Causa / solução |
|---------|-----------------|
| `Cannot find module 'node:sqlite'` | Node < 22.5 → `pkg install nodejs-lts` |
| `Nenhuma implementação de Argon2` | Node < 24.7 e o `argon2` npm não compilou → atualize o Node |
| `Schema engine error` no Termux | Você rodou `prisma migrate` direto. Use `npm run db:migrate` |
| `dlopen ... EM_X86_64 instead of EM_AARCH64` | Checkout antigo (Prisma 5 com engine Rust) → `git pull` |
| `A migration "X" já foi aplicada, mas o arquivo mudou` | Um `migration.sql` já aplicado foi editado. Restaure o original ou crie uma NOVA migration |
| Banco não abre | `npm run doctor` mostra o problema; confira permissões em `data/` |
| API cai sozinha | Otimização de bateria do Android → `termux-wake-lock` |

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

### URL pública da API (conexão com o MatrixApp)

A URL pública **não é criada pelo código** — ela vem da infraestrutura do
painel. O servidor escuta em `0.0.0.0` na porta alocada (`PORT`/
`SERVER_PORT`) e o painel expõe essa porta no IP/host público do node.

1. No painel, abra a página do servidor e copie o endereço da
   **alocação** (network/allocation) no formato `IP-OU-HOST:PORTA`.
2. A URL da API é `http://IP-OU-HOST:PORTA` (sem barra final). Use
   **HTTPS somente** se o painel oferecer um domínio/subdomínio com SSL
   apontando para essa alocação — nunca coloque `https://` na frente de um
   IP+porta sem SSL válido.
3. Defina `PUBLIC_API_URL` (Server → Variables) com esse valor — o banner
   de startup passa a imprimir a URL e o link do health check.
4. Configure o **mesmo valor** no MatrixApp (`API_BASE_URL`) e valide com
   `GET <URL>/health` pelo navegador do celular.

Detalhes completos em [CONEXAO_APP.md](CONEXAO_APP.md).

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
