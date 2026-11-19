# Arquitetura do Sistema — Shopee Afiliados Bot

## 1. Visão Geral e Origem dos Componentes

O sistema combina apenas componentes leves em Node.js puro (sem Docker, Chromium, Selenium ou Puppeteer):

- **Estrutura Base e Orquestração de Fila/Listener** (`gabrieldamasse-01/bot-de-automacao` adaptado):
  - Organização modular em `src/config/`, `src/utils/` (`delay.js`, `logger.js`, `regex.js`), Express em `src/app.js`, listener em `src/services/groups/listener.js` e fila sequencial em `src/services/queue/dispatcher.js`.
- **Motor WhatsApp Baileys** (reaproveitado do TITAN CRM e 100% isolado):
  - `src/services/whatsapp/engine.js`: `makeWASocket`, `determineReconnectDecision`, proteção `__substituido`, reconexão exponencial com jitter, QR Code para painel, listagem de grupos e envio de texto/imagens.
  - `src/services/whatsapp/message_normalizer.js`: desempacotamento e leitura de mensagens Baileys v7.
  - `src/services/whatsapp/session_lock.js`: trava distribuída no Redis (`lock:session_owner:<sessionId>`) evitando dois processos na mesma sessão.
  - `src/services/whatsapp/pg_auth_state.js`: persistência criptografada (AES-256-GCM) no Neon PostgreSQL (`baileys_auth_state`) para sobreviver a reinícios e deploys no Render.
  - `src/utils/filtro_log_criptografia.js`: bloqueio de dumps de chaves `libsignal` e segredos no console.
- **Integração Oficial Shopee Brasil** (referência técnica MIT `jeffmonteiroo/shopee-br-affiliate-mcp`):
  - `src/services/shopee/client.js`: endpoint oficial `https://open-api.affiliate.shopee.com.br/graphql`, assinatura `SHA256(AppId + Timestamp + Payload + Secret)`, queries `productOfferV2` e mutation `generateShortLink`, validação de até 5 Sub IDs, rate limit local (8.000/h e 500 ms entre chamadas), cache Redis e allowlist anti-SSRF.
  - `src/services/shopee/formatter.js`: formatação de mensagens e pontuação para ranqueamento no Caçador Automático.

## 2. Fluxo de Dados

```text
Painel Web Mobile (Porta 3850, 5 Abas, Cookie HttpOnly + CSRF)
   │
   ├──► Auth / Segurança (scrypt + troca obrigatória + rate limit + audit_logs)
   ├──► Aba 1 WhatsApp ──► WhatsAppEngine (Baileys) ◄──► pg_auth_state (AES-256-GCM no Neon)
   │                                       │            ◄──► session_lock (Upstash Redis)
   ├──► Aba 2 Shopee   ──► ShopeeClient (GraphQL + SHA256) ──► Open API Shopee BR
   ├──► Aba 3 Grupos   ──► GroupListener ──► Dedup (Redis+PG) ──► MessageDispatcher
   ├──► Aba 4 Caçador  ──► HunterScheduler ──► OfferHunter ──► MessageDispatcher
   └──► Aba 5 Conversor──► OfferConverter (Painel ou Privado WA) ──► conversions_history

MessageDispatcher (Sequencial por destino + Backoff + Rate Limit)
   └──► Neon PostgreSQL (queue_jobs + publications_history)
   └──► Upstash Redis (locks por grupo + contador/minuto)
   └──► WhatsAppEngine (envio texto/imagem)
```

## 3. Persistência e Fallback Local

- **Produção (Render):** usa obrigatoriamente **Neon PostgreSQL** (`DATABASE_URL`) e **Upstash Redis** (`REDIS_URL`). Não utiliza SQLite.
- **Desenvolvimento/Testes sem credenciais:** quando `NODE_ENV=test` ou `DATABASE_URL`/`REDIS_URL` não são informadas, os adaptadores `PostgresClient` e `RedisClient` operam explicitamente em `memory_fallback` para validar toda a lógica de negócio sem simular sucesso em produção.
