# Guia de Deploy no Render (Preparado — Aguardando Autorização)

> Este documento descreve o procedimento exato para implantar o **Shopee Afiliados Bot** no **Render** quando o proprietário fornecer as credenciais e autorizar o deploy.

## 1. Infraestrutura Externa Prévia

1. **Neon PostgreSQL:**
   - Criar projeto/banco no Neon.
   - Copiar a `DATABASE_URL` (`postgresql://...sslmode=require`).
2. **Upstash Redis:**
   - Criar banco Redis no Upstash (região próxima ao Render, ex.: Oregon/US-East).
   - Copiar a `REDIS_URL` (`rediss://default:...@...:6379`).
3. **Gerar segredos locais antes do deploy:**
   - `SESSION_ENCRYPTION_KEY`: 32+ caracteres aleatórios (ex.: `openssl rand -hex 32`).
   - `PING_SECRET`: 24+ caracteres aleatórios (ex.: `openssl rand -hex 24`).
   - `ADMIN_PASSWORD_HASH`: gerado via `npm run hash-password -- "SuaSenhaForte"`.

## 2. Criação do Web Service no Render (via `render.yaml` ou Manual)

- **Runtime:** Node
- **Root Directory:** raiz do repositório do Shopee Afiliados
- **Build Command:** `npm ci --omit=dev && npm run build`
- **Start Command:** `npm start`
- **Health Check Path:** `/` (retorna HTTP 200 sem depender de credenciais externas; o endpoint `/api/ping` exige `PING_SECRET` e `/api/health` exige autenticação).
- **Porta:** `PORT=3850`

## 3. Variáveis Obrigatórias no Painel do Render (Environment)

Configure no painel do Render (nunca no código):

- `PORT=3850`
- `NODE_ENV=production`
- `DATABASE_URL`
- `REDIS_URL`
- `SESSION_ENCRYPTION_KEY`
- `ADMIN_PASSWORD_HASH`
- `PING_SECRET`
- `SHOPEE_APP_ID` (opcional no env; pode ser inserido na Aba 2)
- `SHOPEE_SECRET_KEY` (opcional no env; pode ser inserido na Aba 2)
- `DEFAULT_SUB_ID=whatsapp_grupos`

## 4. Plano do Render e Persistência

- A sessão do WhatsApp (Baileys) fica salva criptografada na tabela `baileys_auth_state` do **Neon PostgreSQL**, portanto **não se perde** quando o Render reinicia ou faz novo deploy.
- Para operação 24/7 contínua do robô WhatsApp sem hibernação automática, recomenda-se plano pago contínuo do Render (ex.: Starter ou superior). O Cloudflare Worker de Keep-Alive ajuda a manter atividade periódica no endpoint `/api/ping`, mas não garante disponibilidade em planos gratuitos sujeitos a suspensão ou limites.

## 5. Validação Pós-Deploy

1. Acessar `https://seu-app.onrender.com/` e confirmar carregamento da tela de login.
2. Testar `curl -H "x-ping-secret: SEU_PING_SECRET" https://seu-app.onrender.com/api/ping` → esperado HTTP 200 `{"ok":true,...}`.
3. Entrar no painel, conectar WhatsApp na Aba 1 e testar credenciais Shopee na Aba 2.
