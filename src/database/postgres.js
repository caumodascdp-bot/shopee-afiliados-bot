// ==============================================================================
// Cliente Neon PostgreSQL com pool controlado, timeouts e reconexão segura
// ==============================================================================

const { Pool } = require('pg');
const logger = require('../utils/logger');
const { sleep } = require('../utils/delay');

function resolveSslOption(connectionString) {
  if (!connectionString) return false;
  const lower = connectionString.toLowerCase();
  if (lower.includes('localhost') || lower.includes('127.0.0.1') || lower.includes('sslmode=disable')) {
    return false;
  }
  return { rejectUnauthorized: false };
}

class PostgresClient {
  constructor(options = {}) {
    this.connectionString = (options.connectionString || '').trim();
    this.isTest = Boolean(options.isTest);
    this.maxConnections = options.maxConnections || 8;
    this.pool = null;
    this.ready = false;
    this.mode = this.connectionString && !this.isTest ? 'postgres' : 'memory_fallback';
    this.lastError = null;
  }

  async connect({ retries = 3, retryDelayMs = 2000 } = {}) {
    if (!this.connectionString || this.isTest) {
      this.mode = 'memory_fallback';
      this.ready = false;
      return { connected: false, mode: this.mode };
    }

    if (!this.pool) {
      this.pool = new Pool({
        connectionString: this.connectionString,
        ssl: resolveSslOption(this.connectionString),
        max: this.maxConnections,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 20000,
        statement_timeout: 15000,
        query_timeout: 15000,
        keepAlive: true,
      });

      this.pool.on('error', (err) => {
        this.ready = false;
        this.lastError = err.message;
        logger.error('[POSTGRES] Erro inesperado no pool:', err.message);
      });
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this.pool.query('SELECT 1 AS ok');
        this.ready = true;
        this.mode = 'postgres';
        this.lastError = null;
        logger.info('[POSTGRES] Conectado ao Neon PostgreSQL com sucesso.');
        return { connected: true, mode: 'postgres' };
      } catch (err) {
        this.ready = false;
        this.lastError = err.message;
        logger.warn(`[POSTGRES] Tentativa ${attempt}/${retries} falhou: ${err.message}`);
        if (attempt < retries) {
          await sleep(retryDelayMs * attempt);
        }
      }
    }

    throw new Error(`Falha ao conectar ao PostgreSQL após ${retries} tentativas: ${this.lastError}`);
  }

  isPostgresActive() {
    return this.mode === 'postgres' && Boolean(this.pool);
  }

  async query(sql, params = []) {
    if (!this.isPostgresActive()) {
      throw new Error('PostgreSQL não está ativo neste modo de execução.');
    }
    try {
      const res = await this.pool.query(sql, params);
      this.ready = true;
      return res;
    } catch (err) {
      if (err && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === '57P01')) {
        this.ready = false;
      }
      throw err;
    }
  }

  async withTransaction(callback) {
    if (!this.isPostgresActive()) {
      throw new Error('Transação PostgreSQL indisponível fora do modo postgres.');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  }

  async healthCheck() {
    if (!this.isPostgresActive()) {
      return {
        ok: false,
        mode: this.mode,
        configured: Boolean(this.connectionString),
        error: this.connectionString ? 'Modo de teste ou desconectado' : 'DATABASE_URL não configurada',
      };
    }
    const start = Date.now();
    try {
      await this.pool.query('SELECT 1 AS ok');
      this.ready = true;
      return {
        ok: true,
        mode: 'postgres',
        configured: true,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      this.ready = false;
      this.lastError = err.message;
      return {
        ok: false,
        mode: 'postgres',
        configured: true,
        latencyMs: Date.now() - start,
        error: err.message,
      };
    }
  }

  async close() {
    if (this.pool) {
      try {
        await this.pool.end();
      } catch (_) {}
      this.pool = null;
    }
    this.ready = false;
  }
}

module.exports = { PostgresClient, resolveSslOption };
