# Guia de Configuração — Variáveis de Ambiente e Painel

## 1. Variáveis de Ambiente (`.env.example`)

- `PORT`: porta HTTP da aplicação (padrão obrigatório: `3850`).
- `NODE_ENV`: `production` em produção ou `development`/`test` localmente.
- `DATABASE_URL`: string de conexão do **Neon PostgreSQL** (`postgresql://...?sslmode=require`).
- `REDIS_URL`: string TLS do **Upstash Redis** (`rediss://default:...@...:6379`).
- `SHOPEE_APP_ID`: App ID da Shopee Brasil (pode ficar vazio e ser cadastrado na Aba 2 do painel).
- `SHOPEE_SECRET_KEY`: Secret Key da Shopee Brasil (pode ficar vazio e ser cadastrado na Aba 2 — salvo criptografado em AES-256-GCM no banco).
- `DEFAULT_SUB_ID`: Sub ID padrão para rastreamento (ex.: `whatsapp_grupos`).
- `SESSION_ENCRYPTION_KEY`: chave longa (mínimo 32 caracteres aleatórios) usada para criptografar em repouso as credenciais da sessão Baileys e a Secret Key da Shopee no PostgreSQL. **Não perca nem troque sem reautenticar o WhatsApp.**
- `ADMIN_PASSWORD_HASH`: hash `scrypt` gerado com `npm run hash-password -- "SuaSenha"`. Se deixado vazio no primeiro boot, o sistema gera uma senha provisória aleatória no log de inicialização e exige troca obrigatória no primeiro acesso ao painel.
- `PING_SECRET`: segredo aleatório compartilhado entre o Render e o Cloudflare Worker para autorizar `GET /api/ping`.

## 2. Parâmetros Opcionais de Controle Conservador

- `REDIS_PREFIX`: prefixo das chaves no Upstash (padrão: `shopee_afiliados:`).
- `MIN_DELAY_SECONDS`: pausa mínima entre envios no mesmo grupo (padrão: `15`).
- `MAX_DELAY_SECONDS`: pausa máxima entre envios no mesmo grupo (padrão: `45`).
- `MAX_SENDS_PER_MINUTE`: teto global de mensagens por minuto (padrão: `3`).
- `HUNTER_DEFAULT_INTERVAL_MINUTES`: intervalo padrão do caçador (padrão: `60`).
- `LOG_LEVEL`: `DEBUG`, `INFO`, `WARN` ou `ERROR` (padrão: `INFO`).

## 3. Configuração pelo Painel Web (5 Abas)

1. **WhatsApp:** clique em *Conectar / Gerar QR*, leia o QR Code com seu celular e aguarde o status `CONNECTED`.
2. **Shopee:** informe App ID, Secret Key e Sub ID padrão, salve e clique em *Testar Conexão Shopee*.
3. **Grupos:** clique em *Sincronizar Grupos*, marque os grupos **Origem** e **Destino**, ajuste bloqueio de duplicadas e ative o espelhamento quando estiver pronto.
4. **Caçador:** cadastre palavras-chave, comissão mínima, faixa de preço e vendas mínimas; salve e só clique em *Ligar Piloto Automático* após validar com *Buscar Agora*.
5. **Conversor:** cole qualquer link Shopee para gerar link curto e mensagem pronta com 1 clique.
