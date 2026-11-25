const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { Repository } = require('../src/database/repository');

test('PostgreSQL: inserir e atualizar configuração de grupo preserva campos omitidos', { skip: !process.env.TEST_POSTGRES_URL }, async () => {
  const client = new Client({ connectionString: process.env.TEST_POSTGRES_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE whatsapp_groups (
      jid varchar(128) PRIMARY KEY, name varchar(255) NOT NULL DEFAULT '',
      is_source boolean NOT NULL DEFAULT false, is_destination boolean NOT NULL DEFAULT false,
      rules_json jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    const repo = new Repository({ pgClient: { isPostgresActive: () => true, query: client.query.bind(client) } });
    const jid = '123456789@g.us';
    let row = await repo.updateWhatsAppGroupConfig(jid, { isSource: true });
    assert.equal(row.name, jid);
    assert.equal(row.is_source, true);
    row = await repo.updateWhatsAppGroupConfig(jid, { isDestination: true, rules: { minPrice: 20 } });
    assert.equal(row.is_source, true);
    assert.equal(row.is_destination, true);
    assert.equal(row.rules_json.minPrice, 20);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
});
