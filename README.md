# Shopee Afiliados Bot

Plataforma completa e leve de automação para afiliados da **Shopee Brasil** em Node.js, preparada para rodar no **Render** (ou localmente via PM2), com:

- **Motor WhatsApp Baileys (`@whiskeysockets/baileys`)** reaproveitado do TITAN CRM e 100% isolado (sem Puppeteer, sem Chromium e sem `whatsapp-web.js`).
- **Integração Oficial Shopee Affiliate Open API (GraphQL Brasil)** com assinatura SHA-256, busca de produtos (`productOfferV2`), geração de links curtos (`generateShortLink`), Sub IDs e proteção contra SSRF.
- **Banco principal Neon PostgreSQL** com migrations versionadas e persistência criptografada (AES-256-GCM) da sessão Baileys.
- **Cache, filas e locks distribuídos no Upstash Redis** para evitar duplicidade e sessões concorrentes.
- **Painel Administrativo Mobile-First (tema escuro, porta `3850`)** com autenticação obrigatória e 5 abas: WhatsApp, Shopee, Grupos & Espelhamento, Caçador Automático e Conversor Rápido.
- **Cloudflare Worker exclusivo** com Cron Trigger a cada 10 minutos apontando para `GET /api/ping`.

## Comandos Principais

```bash
# Instalar dependências (produção)
npm install --omit=dev

# Validar sintaxe e dependências (Build Check)
npm run build

# Executar suíte de testes automatizados
npm test

# Executar migrations no Neon PostgreSQL (com DATABASE_URL configurada)
npm run migrate

# Gerar hash seguro para ADMIN_PASSWORD_HASH
npm run hash-password -- "SuaSenhaForteAqui"

# Iniciar servidor na porta 3850
npm start

# Gerenciar via PM2 (processo isolado "shopee-bot")
pm2 start ecosystem.config.cjs
pm2 logs shopee-bot
pm2 restart shopee-bot
pm2 stop shopee-bot
```

## Documentação do Projeto

- [Arquitetura do Sistema](ARQUITETURA.md)
- [Guia de Instalação](INSTALACAO.md)
- [Guia de Configuração e Variáveis](CONFIGURACAO.md)
- [Procedimento de Deploy no Render](DEPLOY_RENDER.md)
- [Cloudflare Worker Keep-Alive](CLOUDFLARE_WORKER.md)
- [Segurança e Privacidade](SEGURANCA.md)
- [Licenças e Atribuições](docs/THIRD_PARTY_LICENSES.md)
- [Status Atual do Projeto](STATUS.md)
- [Relatório de Testes e Homologação](RELATORIO_TESTES.md)
