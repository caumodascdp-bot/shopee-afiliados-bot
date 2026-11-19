// ==============================================================================
// Cliente Upstash Redis com locks atômicos, cache, filas e fallback em memória
// Padrão de operações atômicas (SET NX EX + Lua CAS) adaptado do TITAN CRM
// ==============================================================================

const { createClient } = require('redis');
const logger = require('../utils/logger');

class RedisClient {
  constructor(options = {}) {
    this.url = (options.url || '').trim();
    this.prefix = (options.prefix || 'shopee_afiliados:').trim();
    this.isTest = Boolean(options.isTest);
    this.client = null;
    this.ready = false;
    this.mode = this.url && !this.isTest ? 'redis' : 'memory_fallback';
    this.lastError = null;
    this._mem = new Map();
    this._lists = new Map();
  }

  pk(key) {
    if (!this.prefix || key.startsWith(this.prefix)) return key;
    return `${this.prefix}${key}`;
  }

  isRedisActive() {
    return this.mode === 'redis' && Boolean(this.client) && this.ready;
  }

  async connect() {
    if (!this.url || this.isTest) {
      this.mode = 'memory_fallback';
      this.ready = false;
      return { connected: false, mode: this.mode };
    }

    if (!this.client) {
      const isTls = this.url.startsWith('rediss://');
      this.client = createClient({
        url: this.url,
        pingInterval: 15000,
        socket: {
          tls: isTls,
          keepAlive: true,
          connectTimeout: 10000,
          reconnectStrategy: (retries) => Math.min(retries * 200, 3000),
        },
      });

      this.client.on('ready', () => {
        this.ready = true;
        this.lastError = null;
        logger.info('[REDIS] Conectado ao Upstash Redis.');
      });
      this.client.on('reconnecting', () => {
        this.ready = false;
        logger.warn('[REDIS] Reconectando ao Upstash Redis...');
      });
      this.client.on('end', () => {
        this.ready = false;
      });
      this.client.on('error', (err) => {
        this.ready = false;
        this.lastError = err.message;
        logger.error('[REDIS] Erro de conexão:', err.message);
      });
    }

    await this.client.connect();
    this.ready = true;
    this.mode = 'redis';
    return { connected: true, mode: 'redis' };
  }

  _purgeIfExpired(fullKey) {
    const entry = this._mem.get(fullKey);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      this._mem.delete(fullKey);
      return null;
    }
    return entry;
  }

  async get(key) {
    const k = this.pk(key);
    if (this.isRedisActive()) {
      return this.client.get(k);
    }
    const entry = this._purgeIfExpired(k);
    return entry ? entry.value : null;
  }

  async set(key, value, { exSeconds = null } = {}) {
    const k = this.pk(key);
    const val = String(value);
    if (this.isRedisActive()) {
      if (exSeconds) {
        return this.client.set(k, val, { EX: exSeconds });
      }
      return this.client.set(k, val);
    }
    const expiresAt = exSeconds ? Date.now() + exSeconds * 1000 : null;
    this._mem.set(k, { value: val, expiresAt });
    return 'OK';
  }

  async del(key) {
    const k = this.pk(key);
    if (this.isRedisActive()) {
      return this.client.del(k);
    }
    const deleted = this._mem.delete(k);
    const deletedList = this._lists.delete(k);
    return deleted || deletedList ? 1 : 0;
  }

  async getJson(key) {
    const raw = await this.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  async setJson(key, obj, exSeconds = 300) {
    return this.set(key, JSON.stringify(obj), { exSeconds });
  }

  async setIfAbsent(key, value, exSeconds = 60) {
    const k = this.pk(key);
    const val = String(value);
    if (this.isRedisActive()) {
      const res = await this.client.set(k, val, { NX: true, EX: exSeconds });
      return res === 'OK';
    }
    const existing = this._purgeIfExpired(k);
    if (existing) return false;
    this._mem.set(k, { value: val, expiresAt: Date.now() + exSeconds * 1000 });
    return true;
  }

  async replaceIfEquals(key, expected, nextValue, exSeconds = 60) {
    const k = this.pk(key);
    if (this.isRedisActive()) {
      const script =
        "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3]) return 1 else return 0 end";
      const res = await this.client.eval(script, {
        keys: [k],
        arguments: [String(expected), String(nextValue), String(exSeconds)],
      });
      return Number(res) === 1;
    }
    const entry = this._purgeIfExpired(k);
    if (!entry || entry.value !== String(expected)) return false;
    this._mem.set(k, { value: String(nextValue), expiresAt: Date.now() + exSeconds * 1000 });
    return true;
  }

  async deleteIfEquals(key, expected) {
    const k = this.pk(key);
    if (this.isRedisActive()) {
      const script =
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
      const res = await this.client.eval(script, { keys: [k], arguments: [String(expected)] });
      return Number(res) === 1;
    }
    const entry = this._purgeIfExpired(k);
    if (!entry || entry.value !== String(expected)) return false;
    this._mem.delete(k);
    return true;
  }

  async ttl(key) {
    const k = this.pk(key);
    if (this.isRedisActive()) {
      return this.client.ttl(k);
    }
    const entry = this._purgeIfExpired(k);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  }

  async incrWithExpire(key, exSeconds = 60) {
    const k = this.pk(key);
    if (this.isRedisActive()) {
      const count = await this.client.incr(k);
      if (count === 1) {
        await this.client.expire(k, exSeconds);
      }
      return count;
    }
    const entry = this._purgeIfExpired(k);
    if (!entry) {
      this._mem.set(k, { value: '1', expiresAt: Date.now() + exSeconds * 1000 });
      return 1;
    }
    const next = (Number.parseInt(entry.value, 10) || 0) + 1;
    entry.value = String(next);
    return next;
  }

  async lPush(key, value) {
    const k = this.pk(key);
    const val = typeof value === 'string' ? value : JSON.stringify(value);
    if (this.isRedisActive()) {
      return this.client.lPush(k, val);
    }
    const arr = this._lists.get(k) || [];
    arr.unshift(val);
    this._lists.set(k, arr);
    return arr.length;
  }

  async rPop(key) {
    const k = this.pk(key);
    if (this.isRedisActive()) {
      return this.client.rPop(k);
    }
    const arr = this._lists.get(k) || [];
    if (!arr.length) return null;
    return arr.pop();
  }

  async lRange(key, start = 0, stop = -1) {
    const k = this.pk(key);
    if (this.isRedisActive()) {
      return this.client.lRange(k, start, stop);
    }
    const arr = this._lists.get(k) || [];
    const end = stop < 0 ? arr.length + stop + 1 : stop + 1;
    return arr.slice(start, end);
  }

  async healthCheck() {
    if (!this.url || this.isTest) {
      return {
        ok: false,
        mode: 'memory_fallback',
        configured: Boolean(this.url),
        error: this.url ? 'Modo de teste' : 'REDIS_URL não configurada',
      };
    }
    const start = Date.now();
    try {
      const pong = await this.client.ping();
      return {
        ok: pong === 'PONG',
        mode: 'redis',
        configured: true,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      this.lastError = err.message;
      return {
        ok: false,
        mode: 'redis',
        configured: true,
        latencyMs: Date.now() - start,
        error: err.message,
      };
    }
  }

  async close() {
    if (this.client) {
      try {
        await this.client.quit();
      } catch (_) {
        try {
          await this.client.disconnect();
        } catch (_) {}
      }
      this.client = null;
    }
    this.ready = false;
  }
}

module.exports = { RedisClient };
