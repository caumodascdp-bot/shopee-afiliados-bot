# Guia de Instalação (Local / Termux / Linux / Render)

## 1. Pré-requisitos

- **Node.js** `>= 20.19.0` (homologado em Node `v22.23.1` ARM64).
- **npm** `>= 10`.
- Conta **Neon PostgreSQL** e **Upstash Redis** para persistência em produção.
- Credenciais **Shopee Open API Brasil** (App ID e Secret Key).

## 2. Instalação em Pasta Exclusiva

```bash
cd ~/apps/shopee-afiliados-bot
npm install --omit=dev
```

> Este projeto **não** instala Puppeteer, Chromium, Selenium, Playwright, `whatsapp-web.js` ou SQLite.

## 3. Configuração Inicial

```bash
cp .env.example .env
# Preencha DATABASE_URL, REDIS_URL, SESSION_ENCRYPTION_KEY e PING_SECRET no arquivo .env
```

Para gerar o hash da senha administrativa (`ADMIN_PASSWORD_HASH`):

```bash
npm run hash-password -- "SuaSenhaForteAqui"
```

## 4. Executar Migrations do Banco

```bash
npm run migrate
```

## 5. Verificação de Build e Testes

```bash
npm run build
npm test
npm run smoke-check
npm run measure-memory
```

## 6. Inicialização e Administração via PM2 (Processo Isolado)

```bash
# Iniciar apenas o processo shopee-bot
pm2 start ecosystem.config.cjs
pm2 save

# Ver status, reiniciar ou parar apenas o shopee-bot
pm2 status shopee-bot
pm2 logs shopee-bot
pm2 restart shopee-bot
pm2 stop shopee-bot
```

> **Regra de segurança:** nunca execute `pm2 delete all` ou `pm2 kill` no Termux/servidor se houver outros serviços rodando; opere sempre especificando `shopee-bot`.
