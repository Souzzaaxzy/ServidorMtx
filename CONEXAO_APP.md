# Conexão App ↔ API

## Arquitetura

```
MatrixApp ──► URL PÚBLICA (Bronxys/Pterodactyl) ──► ServidorMtx ──► data/matrix.db (SQLite)
```

UMA API, UMA URL, UM servidor, UM banco. Sem túneis, sem URLs externas,
sem segunda API, sem localhost no APK.

## Qual é a URL pública?

A URL pública **não é criada pelo código** — ela vem da infraestrutura da
Bronxys/Pterodactyl. O servidor escuta em `0.0.0.0` na porta alocada pelo
painel (`PORT`/`SERVER_PORT`), e o painel expõe essa porta no IP/host
público do node.

Para descobrir o endereço real:

1. Abra o painel da Bronxys → seu servidor → página principal.
2. Na seção de **alocação / network** (allocation), copie o endereço no
   formato `IP-OU-HOST:PORTA` (ex.: `123.45.67.89:4316` ou
   `node-br1.exemplo.com:4316`).
3. A URL da API é `http://IP-OU-HOST:PORTA` (sem barra final).
   - Use **HTTPS somente se** o painel oferecer um domínio/proxy com SSL
     válido (ex.: aba "Domains"/"Subdomains" apontando para esta
     alocação). Um IP+porta direto da Pterodactyl normalmente é HTTP puro —
     não coloque `https://` na frente dele.
4. Teste externamente (navegador do celular): `URL/health` deve responder
   `{"status":"ok",...}`.

## Onde configurar

- **Servidor (informativo/diagnóstico):** variável `PUBLIC_API_URL` no
  painel (Server → Variables). O banner de startup imprime a URL e o link
  do health check.
- **App (MatrixApp):** `app/lib/data/api_config.dart` (constante
  `_productionUrl`) ou, preferencialmente, o secret `API_BASE_URL` do
  GitHub Actions, injetado no build de release via
  `--dart-define=API_BASE_URL=...`.

## Verificação end-to-end

1. `GET URL/health` → HTTP 200.
2. `POST URL/api/auth/register` com
   `{"name":"Teste","username":"teste_matrix","password":"Matrix123"}`
   → HTTP 201 com tokens + `recoveryCode`.
3. `POST URL/api/auth/login` com
   `{"username":"teste_matrix","password":"Matrix123"}` → HTTP 200.
4. No APK: criar conta → entrar → sair → entrar de novo.
