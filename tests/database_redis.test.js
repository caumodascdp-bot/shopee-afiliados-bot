const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { listMigrationFiles, DEFAULT_MIGRATIONS_DIR } = require('../src/database/migrator');
const { resolveSslOption } = require('../src/database/postgres');
const { Repository } = require('../src/database/repository');
const { RedisClient } = require('../src/redis/client');

test('PostgreSQL Neon: migrations SQL válidas, tabelas relacionais, FKs e índices declarados', () => {
  const files = listMigrationFiles(DEFAULT_MIGRATIONS_DIR);
  assert.ok(files.includes('001_initial_schema.sql'));

  const sql = fs.readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, '001_initial_schema.sql'), 'utf8');
  const requiredTables = [
    'schema_migrations',
    'admin_users',
    'app_settings',
    'shopee_credentials',
    'whatsapp_groups',
    'hunter_keywords',
    'products',
    'offers',
    'conversions_history',
    'queue_jobs',
    'publications_history',
    'audit_logs',
    'baileys_auth_state',
  ];
  for (const tbl of requiredTables) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${tbl}\\b`), `Tabela ausente: ${tbl}`);
  }
  assert.match(sql, /REFERENCES products\(id\)/);
  assert.match(sql, /REFERENCES offers\(id\)/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_queue_jobs_status_next_dest/);

  assert.deepEqual(resolveSslOption('postgresql://user:pass@ep-cool.neon.tech/neondb?sslmode=require'), {
    rejectUnauthorized: false,
  });
  assert.equal(resolveSslOption('postgresql://localhost:5432/test'), false);
});

test('Repository: CRUD relacional completo (admin, produtos, ofertas, conversões, fila e auditoria)', async () => {
  const repo = new Repository();
  const prod = await repo.upsertProduct({
    itemId: '5001',
    shopId: '9001',
    title: 'Aspirador Robô',
    priceMin: 499.9,
    priceMax: 599.9,
    productUrl: 'https://shopee.com.br/product/9001/5001',
  });
  assert.equal(prod.item_id, '5001');

  const offer = await repo.createOffer({
    productId: prod.id,
    sourceType: 'hunter',
    title: prod.title,
    affiliateUrl: 'https://shope.ee/5001',
    formattedMessage: 'Msg',
    dedupHash: 'hash5001',
  });
  assert.equal(await repo.hasRecentOfferByHash('hash5001', 24), true);

  await repo.addAuditLog({ actor: 'admin', action: 'test.action', resource: 'products' });
  const logs = await repo.listAuditLogs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'test.action');
  assert.ok(offer.id > 0);
});

test('Redis Upstash: prefixo isolado, cache JSON, listas FIFO e locks atômicos CAS', async () => {
  const redis = new RedisClient({ prefix: 'shopee_afiliados:', isTest: true });
  assert.equal(redis.pk('chave'), 'shopee_afiliados:chave');

  await redis.setJson('cache:prod:1', { ok: true }, 60);
  assert.deepEqual(await redis.getJson('cache:prod:1'), { ok: true });

  await redis.lPush('fila:teste', { id: 1 });
  await redis.lPush('fila:teste', { id: 2 });
  assert.equal(JSON.parse(await redis.rPop('fila:teste')).id, 1);

  assert.equal(await redis.setIfAbsent('lock:1', 'ownerA', 30), true);
  assert.equal(await redis.setIfAbsent('lock:1', 'ownerB', 30), false);
  assert.equal(await redis.replaceIfEquals('lock:1', 'ownerB', 'ownerB', 30), false);
  assert.equal(await redis.replaceIfEquals('lock:1', 'ownerA', 'ownerA', 60), true);
  assert.equal(await redis.deleteIfEquals('lock:1', 'ownerB'), false);
  assert.equal(await redis.deleteIfEquals('lock:1', 'ownerA'), true);
});
