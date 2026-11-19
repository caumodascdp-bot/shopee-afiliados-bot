# Segurança e Proteção de Dados — Shopee Afiliados Bot

## 1. Proteção de Credenciais e Sessão WhatsApp

- **Criptografia em repouso (AES-256-GCM):** tanto a `SHOPEE_SECRET_KEY` quanto todas as chaves e credenciais Signal/Baileys gravadas na tabela `baileys_auth_state` do Neon PostgreSQL são criptografadas com `SESSION_ENCRYPTION_KEY` e AAD vinculada ao identificador da chave.
- **Ocultação em logs e interface:**
  - `src/utils/filtro_log_criptografia.js` intercepta chamadas ao `console` antes do boot e silencia/remove dumps de sessão Signal e segredos (`SHOPEE_SECRET_KEY`, `DATABASE_URL`, `REDIS_URL`, `PING_SECRET`, tokens Bearer e cabeçalhos `Authorization: SHA256 ...`).
  - A API `GET /api/shopee/config` nunca devolve a Secret Key original — retorna apenas `hasSecretKey` e uma máscara (`ab************yz`).
- **Prevenção de colisão de sessão WhatsApp:** `src/services/whatsapp/session_lock.js` mantém trava distribuída no Upstash Redis (`lock:session_owner:<sessionId>`) para impedir dois processos usando o mesmo número simultaneamente.

## 2. Autenticação, Troca de Senha e Proteção Web

- **Hash de senha:** `crypto.scryptSync` com salt aleatório de 16 bytes e comparação em tempo constante (`crypto.timingSafeEqual`).
- **Troca obrigatória de senha provisória:** se `ADMIN_PASSWORD_HASH` não for fornecido, o primeiro boot gera uma senha provisória aleatória (nunca fixa no código) com `must_change_password = true`, bloqueando todas as rotas operacionais com HTTP `403 PASSWORD_CHANGE_REQUIRED` até a troca para uma senha com mínimo de 8 caracteres.
- **Sessão segura:** cookie `HttpOnly`, `SameSite=Strict`, `Secure` em produção, assinado com HMAC-SHA256.
- **Proteção CSRF:** todas as requisições mutáveis exigem `X-Requested-With: XMLHttpRequest` e validação de `Origin`/`Host`.
- **Rate Limiting e Headers HTTP:** `express-rate-limit` protege `/api/auth/login` e as rotas `/api/*`; `helmet` aplica CSP restritiva (bloqueando scripts inline e framing).
- **Auditoria:** logins, falhas de login, troca de senha, alterações de credenciais, sincronização de grupos e disparos do caçador ficam registrados na tabela `audit_logs`.

## 3. Proteção Anti-SSRF

- `src/utils/url_validator.js` restringe URLs de entrada/resolução da Shopee exclusivamente a HTTPS nos domínios oficiais (`shopee.com.br`, `www.shopee.com.br`, `s.shopee.com.br`, `shope.ee`, `br.shp.ee`) e imagens apenas em CDNs Shopee (`*.susercontent.com`, `*.shopee.com.br`), bloqueando `localhost`, IPs privados (`10.*`, `172.16-31.*`, `192.168.*`, `169.254.*`, `127.0.0.1`, `::1`), portas não-443 e credenciais embutidas na URL.

## 4. Isolamento do Ecossistema Local

- Nenhuma pasta, banco, sessão WhatsApp, arquivo `.env` ou processo de `TITANCRM`, `SniperFila`, `Artemis`, `Termúsica`, `cloudflared` ou outros Workers foi modificado.
