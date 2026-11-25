const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { Repository } = require('../src/database/repository');

test('Postgres correlaciona recibo uma única vez e preserva histórico anterior', {skip: !process.env.TEST_POSTGRES_URL}, async () => {
  const client = new Client({ connectionString: process.env.TEST_POSTGRES_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE SCHEMA delivery_test_' + process.pid);
    await client.query('SET LOCAL search_path TO delivery_test_' + process.pid);
    const migrate = file => client.query(fs.readFileSync(path.join(__dirname, '../src/database/migrations', file), 'utf8'));
    await migrate('001_initial_schema.sql');
    await client.query("INSERT INTO queue_jobs(idempotency_key,destination_jid,payload_json,status) VALUES ('old','g','{}','sent')");
    await migrate('002_group_delivery.sql');
    const repo = new Repository({pgClient:{isPostgresActive:()=>true, query:client.query.bind(client)}});
    const {job} = await repo.enqueueJob({idempotencyKey:'hunter:7:g', destinationJid:'g', payload:{text:'offer'}});
    await repo.markJobProcessing(job.id);
    assert.equal(await repo.reserveWhatsAppMessage(job.id,'id'), true);
    assert.equal(await repo.recoverStaleProcessingJobs(), 0);
    assert.equal(await repo.recordWhatsAppReceipt('other','id'), false);
    assert.equal(await repo.recordWhatsAppReceipt('g','id'), true);
    assert.equal(await repo.recordWhatsAppReceipt('g','id'), false);
    assert.equal((await repo.getQueueStats()).delivered, 1);
    assert.equal((await repo.getQueueStats()).sent, 1);
    assert.equal((await repo.listPublications()).length, 1);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
