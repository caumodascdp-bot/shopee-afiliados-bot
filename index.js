// ==============================================================================
// ENTRYPOINT PRINCIPAL — Shopee Afiliados Bot
// Instala filtro de logs antes de carregar qualquer módulo WhatsApp/Signal
// ==============================================================================

const { instalarFiltroLogCriptografia } = require('./src/utils/filtro_log_criptografia');
instalarFiltroLogCriptografia(console);

const http = require('http');
const config = require('./src/config');
const logger = require('./src/utils/logger');
const cryptoHelper = require('./src/utils/crypto');
const { PostgresClient } = require('./src/database/postgres');
const { runMigrations } = require('./src/database/migrator');
const { Repository } = require('./src/database/repository');
const { RedisClient } = require('./src/redis/client');
const { ShopeeClient } = require('./src/services/shopee/client');
const { WhatsAppEngine } = require('./src/services/whatsapp/engine');
const { GroupManager } = require('./src/services/groups/manager');
const { MessageDispatcher } = require('./src/services/queue/dispatcher');
const { OfferConverter } = require('./src/services/offers/converter');
const { GroupListener } = require('./src/services/groups/listener');
const { OfferHunter } = require('./src/services/offers/hunter');
const { HunterScheduler } = require('./src/jobs/scheduler');
const { ensureAdminProvisioned } = require('./src/middleware/auth');
const { createApp } = require('./src/app');

async function createRuntime(customOverrides = {}) {
  const activeConfig = { ...config, ...customOverrides };
  const pgClient = new PostgresClient({
    connectionString: activeConfig.databaseUrl,
    isTest: activeConfig.isTest,
  });
  await pgClient.connect().catch((err) => {
    logger.warn(`[BOOT] PostgreSQL indisponível no boot (${err.message}).`);
  });

  if (pgClient.isPostgresActive()) {
    await runMigrations(pgClient);
  } else {
    logger.warn('[BOOT] Executando em modo fallback em memória (DATABASE_URL ausente ou modo de teste).');
  }

  const redisClient = new RedisClient({
    url: activeConfig.redisUrl,
    prefix: activeConfig.redisPrefix,
    isTest: activeConfig.isTest,
  });
  await redisClient.connect().catch((err) => {
    logger.warn(`[BOOT] Redis indisponível no boot (${err.message}).`);
  });

  const repository = new Repository({ pgClient });
  const adminBoot = await ensureAdminProvisioned({ repository, config: activeConfig });
  if (adminBoot.provisionalPassword) {
    logger.warn(`[BOOT] Senha provisória gerada para usuário "admin": ${adminBoot.provisionalPassword}`);
    logger.warn('[BOOT] Acesse o painel e troque imediatamente a senha provisória.');
  }

  const shopeeClient = new ShopeeClient({
    repository,
    redis: redisClient,
    cryptoHelper,
    encryptionKey: activeConfig.sessionEncryptionKey,
    endpoint: activeConfig.shopeeApiUrl,
    isProduction: activeConfig.isProduction,
    defaultCredentials: {
      appId: activeConfig.shopeeAppId,
      secretKey: activeConfig.shopeeSecretKey,
      defaultSubId: activeConfig.defaultSubId,
    },
  });

  const whatsapp = new WhatsAppEngine({
    repository,
    redis: redisClient,
    cryptoHelper,
    encryptionKey: activeConfig.sessionEncryptionKey,
    sessionId: activeConfig.sessionId,
    machineId: activeConfig.machineId,
    isProduction: activeConfig.isProduction,
  });

  const groupManager = new GroupManager({ repository, whatsapp });
  const converter = new OfferConverter({ shopeeClient, repository });
  const dispatcher = new MessageDispatcher({
    repository,
    redis: redisClient,
    whatsapp,
    config: activeConfig,
  });
  await dispatcher.init();

  const listener = new GroupListener({
    whatsapp,
    groupManager,
    shopeeClient,
    converter,
    dispatcher,
    repository,
    redis: redisClient,
  });

  const hunter = new OfferHunter({
    repository,
    redis: redisClient,
    shopeeClient,
    dispatcher,
  });
  const scheduler = new HunterScheduler({ hunter });

  const app = createApp({
    config: activeConfig,
    pgClient,
    redisClient,
    repository,
    whatsapp,
    shopeeClient,
    groupManager,
    hunter,
    converter,
    dispatcher,
    cryptoHelper,
    rateLimitOptions: activeConfig.rateLimitOptions || {},
  });

  return {
    config: activeConfig,
    pgClient,
    redisClient,
    repository,
    shopeeClient,
    whatsapp,
    groupManager,
    converter,
    dispatcher,
    listener,
    hunter,
    scheduler,
    app,
    adminBoot,
  };
}

async function startServer() {
  const runtime = await createRuntime();
  const server = http.createServer(runtime.app);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(runtime.config.port, '0.0.0.0', resolve);
  });

  logger.info(`[BOOT] Shopee Afiliados Bot escutando na porta ${runtime.config.port}.`);

  runtime.listener.start();
  runtime.dispatcher.start();
  runtime.scheduler.start();

  // Tenta restaurar sessão WhatsApp salva no Neon se já existir
  runtime.whatsapp.restoreIfAuthenticated().catch((err) => {
    logger.warn(`[BOOT] Não foi possível restaurar sessão WhatsApp automática: ${err.message}`);
  });

  let shuttingDown = false;
  async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[SHUTDOWN] Sinal ${signal} recebido. Encerrando serviços com segurança...`);
    try {
      runtime.scheduler.stop();
      runtime.listener.stop();
      await runtime.dispatcher.stop();
      await runtime.whatsapp.disconnect();
      await new Promise((resolve) => server.close(() => resolve()));
      await runtime.redisClient.close();
      await runtime.pgClient.close();
      logger.closeLogger();
    } catch (err) {
      console.error('[SHUTDOWN] Erro durante encerramento:', err.message);
    }
    process.exit(0);
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  return { server, runtime, gracefulShutdown };
}

if (require.main === module) {
  startServer().catch((err) => {
    logger.error('[BOOT] Falha fatal ao iniciar aplicação:', err.message);
    process.exit(1);
  });
}

module.exports = { createRuntime, startServer };
