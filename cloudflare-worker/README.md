# Cloudflare Worker — Keep-Alive Shopee Afiliados

Worker independente configurado para chamar `GET /api/ping` no Render a cada **10 minutos** (`*/10 * * * *`).

## O que este Worker faz
- Dispara por Cron Trigger a cada 10 minutos.
- Envia `GET ${RENDER_BASE_URL}/api/ping` com o cabeçalho `x-ping-secret`.
- Usa timeout de 10 segundos (`AbortSignal.timeout(10000)`).
- Registra status, latência e erros em logs estruturados e em `lastExecution`.

## Pré-requisitos antes de publicar
1. Ter o serviço Node.js publicado no Render e saber a URL HTTPS dele.
2. Ajustar `RENDER_BASE_URL` no arquivo `wrangler.toml`.
3. Cadastrar o mesmo valor de `PING_SECRET` do Render usando o comando secreto do Wrangler (nunca escrever o segredo no arquivo).

## Como testar localmente
```bash
cd cloudflare-worker
npx wrangler dev --test-scheduled
# Em outro terminal, simular o cron:
curl "http://localhost:8787/__scheduled?cron=*/10+*+*+*+*"
```

## Como publicar (somente após autorização do proprietário)
```bash
cd cloudflare-worker
npx wrangler secret put PING_SECRET
npx wrangler deploy
```

> **Observação importante:** Keep-Alive não substitui um plano contínuo do Render e deve sempre respeitar os termos de uso do Render e da Cloudflare.
