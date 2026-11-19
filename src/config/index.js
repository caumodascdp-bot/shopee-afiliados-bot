// ==============================================================================
// Configuração central do Shopee Afiliados Bot
// Base estrutural inspirada em gabrieldamasse-01/bot-de-automacao e expandida
// para Render, Neon PostgreSQL, Upstash Redis, Baileys e API Oficial Shopee BR
// ==============================================================================

const path = require('path');
const dotenv = require('dotenv');

const ROOT_DIR = path.resolve(__dirname, '../..');

function loadEnv(customEnvPath) {
  const envPath = customEnvPath || path.join(ROOT_DIR, '.env');
  dotenv.config({ path: envPath });
}

loadEnv();

function parsePositiveInt(raw, fallback) {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildConfig(env = process.env) {
  const minDelaySeconds = parsePositiveInt(env.MIN_DELAY_SECONDS, 15);
  const maxDelaySeconds = Math.max(minDelaySeconds, parsePositiveInt(env.MAX_DELAY_SECONDS, 45));

  return {
    rootDir: ROOT_DIR,
    port: parsePositiveInt(env.PORT, 3850),
    nodeEnv: env.NODE_ENV || 'development',
    isProduction: (env.NODE_ENV || 'development') === 'production',
    isTest: (env.NODE_ENV || '') === 'test',

    // Banco e Cache
    databaseUrl: (env.DATABASE_URL || '').trim(),
    redisUrl: (env.REDIS_URL || '').trim(),
    redisPrefix: (env.REDIS_PREFIX || 'shopee_afiliados:').trim(),

    // Shopee Oficial
    shopeeApiUrl: (env.SHOPEE_API_URL || 'https://open-api.affiliate.shopee.com.br/graphql').trim(),
    shopeeAppId: (env.SHOPEE_APP_ID || '').trim(),
    shopeeSecretKey: (env.SHOPEE_SECRET_KEY || '').trim(),
    defaultSubId: (env.DEFAULT_SUB_ID || 'whatsapp_grupos').trim(),

    // Segurança
    sessionEncryptionKey: (env.SESSION_ENCRYPTION_KEY || '').trim(),
    adminPasswordHash: (env.ADMIN_PASSWORD_HASH || '').trim(),
    pingSecret: (env.PING_SECRET || '').trim(),
    authCookieSecret: (env.AUTH_COOKIE_SECRET || env.SESSION_ENCRYPTION_KEY || '').trim(),
    sessionId: (env.WHATSAPP_SESSION_ID || 'shopee_principal').trim(),
    machineId: (env.RENDER_INSTANCE_ID || env.MACHINE_ID || 'shopee-node-1').trim(),

    // Fila e Limites Conservadores (em ms)
    queueDelayMinMs: minDelaySeconds * 1000,
    queueDelayMaxMs: maxDelaySeconds * 1000,
    typingDelayMinMs: parsePositiveInt(env.TYPING_DELAY_MIN, 2000),
    typingDelayMaxMs: parsePositiveInt(env.TYPING_DELAY_MAX, 5000),
    queueCheckIntervalMs: parsePositiveInt(env.QUEUE_CHECK_INTERVAL, 5000),
    maxSendsPerMinute: parsePositiveInt(env.MAX_SENDS_PER_MINUTE, 3),
    maxAttempts: parsePositiveInt(env.QUEUE_MAX_ATTEMPTS, 3),

    // Caçador Automático
    hunterDefaultIntervalMinutes: parsePositiveInt(env.HUNTER_DEFAULT_INTERVAL_MINUTES, 60),

    // Logs
    logLevel: (env.LOG_LEVEL || 'INFO').toUpperCase(),
    logsDir: path.join(ROOT_DIR, 'logs'),
  };
}

module.exports = {
  ...buildConfig(process.env),
  buildConfig,
  loadEnv,
};
