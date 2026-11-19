# Documentação do Cloudflare Worker Exclusivo (Keep-Alive 10 min)

O Worker foi criado em pasta isolada (`cloudflare-worker/`) exclusivamente para o **Shopee Afiliados Bot**, sem alterar nem reutilizar nenhum Worker existente.

## 1. Arquivos Criados

- `cloudflare-worker/src/worker.js` — código completo com Cron Trigger (`scheduled`), endpoint de inspeção autenticado (`fetch`), timeout de 10s (`AbortSignal.timeout`), logs estruturados e registro de última execução.
- `cloudflare-worker/wrangler.toml` — configuração do Worker `shopee-afiliados-keepalive` com `crons = ["*/10 * * * *"]`.
- `cloudflare-worker/package.json` — scripts de teste local e deploy.
- `cloudflare-worker/README.md` — guia rápido de publicação.

## 2. Como Funciona

1. A cada 10 minutos, a Cloudflare executa `scheduled()`.
2. O Worker envia `GET ${RENDER_BASE_URL}/api/ping` com o header `x-ping-secret: env.PING_SECRET`.
3. No servidor Node.js (Render), `GET /api/ping` apenas valida `PING_SECRET` em tempo constante e retorna HTTP 200 imediato, **sem consultar PostgreSQL, Redis, filas ou Shopee**.
4. Se o Render retornar HTTP 5xx, 401 ou estourar o timeout de 10 segundos, o Worker registra o erro em `lastExecution` e no log sem lançar exceção não tratada.

## 3. Como Testar Localmente (Sem Publicar)

- Via suíte automatizada do projeto: `npm test` executa `tests/cloudflare_worker.test.js` validando o módulo real do Worker.
- Via Wrangler em modo local:
  ```bash
  cd cloudflare-worker
  npx wrangler dev --test-scheduled
  ```

## 4. Como Publicar (Somente Após Autorização)

```bash
cd cloudflare-worker
# 1. Atualize RENDER_BASE_URL no wrangler.toml com a URL real do Render
# 2. Cadastre o segredo sem salvar em arquivo:
npx wrangler secret put PING_SECRET
# 3. Publique o Worker:
npx wrangler deploy
```

> **Aviso importante:** Keep-Alive a cada 10 minutos não garante 100% de disponibilidade em instâncias gratuitas e deve respeitar integralmente os termos de uso do Render e da Cloudflare.
