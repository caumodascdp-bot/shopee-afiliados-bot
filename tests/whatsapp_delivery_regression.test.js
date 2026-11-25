const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Repository } = require('../src/database/repository');
const { MessageDispatcher } = require('../src/services/queue/dispatcher');
const { WhatsAppEngine } = require('../src/services/whatsapp/engine');
const { groupDiagnostics } = require('../src/services/whatsapp/delivery_diagnostics');

const group = '123456789@g.us';
async function setup(send, announce = false) {
  const repo = new Repository();
  const engine = new WhatsAppEngine({ repository: repo });
  engine.status = 'CONNECTED';
  const sock = engine.sock = {
    user: { id: '100:2@s.whatsapp.net' }, ev: new EventEmitter(),
    groupMetadata: async () => ({ announce, participants: [{ id: '100@s.whatsapp.net' }] }),
    sendMessage: send,
  };
  engine.inspectGroup = groupDiagnostics(sock, {info(){},warn(){}}, repo);
  const queue = new MessageDispatcher({ repository: repo, whatsapp: engine });
  await queue.enqueue({ destinationJid: group, text: 'Oferta https://example.org', imageUrl: 'https://example.org/image', idempotencyKey: 'hunter:1:' + group });
  return {repo, sock, queue, process: () => queue.processPendingBatch({ skipDelay: true })};
}

test('oferta em texto só recebe confirmação para o ID e grupo corretos, mesmo antes do retorno', async () => {
  const s = await setup(async (jid, content, opts) => {
    assert.equal(jid, group);
    assert.equal(content.text, 'Oferta https://example.org');
    assert.equal(content.image, undefined);
    const key = { remoteJid: group, fromMe: true, id: opts.messageId };
    function receipt(k) { s.sock.ev.emit('message-receipt.update', [{ key: k, receipt: { userJid: '300@lid', receiptTimestamp: 1 } }]); }
    receipt({...key,remoteJid:'7654321@g.us'});
    receipt({...key,id:'unrelated'});
    s.sock.ev.emit('message-receipt.update', [{ key, receipt: { userJid: '300@lid', readTimestamp: 1 } }]);
    assert.equal((await s.repo.getQueueStats()).awaiting_receipt, 1);
    receipt(key);
    receipt(key);
    return { key };
  });
  await s.process();
  assert.equal((await s.repo.getQueueStats()).delivered, 1);
  assert.equal((await s.repo.listPublications()).length, 1);
});

for (const result of ['local','sem ID','timeout']) {
  test('sem recibo permanece sem confirmação e não duplica após reinício: ' + result, async () => {
    let calls = 0;
    const s = await setup(async (jid, content, opts) => {
      calls++;
      if (result === 'timeout') throw new Error('timeout');
      return result === 'local' ? {key:{id:opts.messageId}} : {};
    });
    await s.process();
    await s.queue.init();
    await s.process();
    assert.equal(calls, 1);
    assert.equal((await s.repo.getQueueStats()).awaiting_receipt, 1);
    assert.equal((await s.repo.listPublications()).length, 0);
  });
}

test('grupo exclusivo para administradores bloqueia disparo de membro', async () => {
  let calls = 0;
  const s = await setup(async () => { calls++; }, true);
  await s.process();
  assert.equal(calls, 0);
  assert.equal((await s.repo.getQueueStats()).dead_letter, 1);
});

test('recusa posterior à submissão é registrada com o código do WhatsApp', async () => {
  let key;
  const s = await setup(async (jid, content, opts) => ({key: key = {remoteJid: jid, fromMe:true, id:opts.messageId}}));
  await s.process();
  s.sock.ev.emit('messages.update',[{key,update:{status:0,messageStubParameters:['403']}}]);
  assert.equal((await s.repo.getQueueStats()).dead_letter, 1);
  assert.match((await s.repo.listPublications())[0].error_message,/403/);
});
