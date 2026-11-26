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
  await queue.enqueue({ destinationJid: group, text: 'Oferta https://example.org', imageUrl: 'https://down-br.img.susercontent.com/image', idempotencyKey: 'hunter:1:' + group });
  return {repo, sock, queue, process: () => queue.processPendingBatch({ skipDelay: true })};
}

test('oferta em texto só recebe confirmação para o ID e grupo corretos, mesmo antes do retorno', async () => {
  const s = await setup(async (jid, content, opts) => {
    assert.equal(jid, group);
    assert.equal(content.caption, 'Oferta https://example.org');
    assert.deepEqual(content.image, { url: 'https://down-br.img.susercontent.com/image' });
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

test('recusa 421 é correlacionada ao ID e grupo e não é reenviada automaticamente', async () => {
  const s = await setup(async (jid, content, opts) => ({
    key: { remoteJid: jid, fromMe: true, id: opts.messageId },
  }));
  await s.process();
  const job = s.repo._memory.queueJobs[0];
  s.sock.ev.emit('messages.update', [{
    key: { remoteJid: group, fromMe: true, id: job.whatsapp_message_id },
    update: { status: 0, messageStubParameters: ['421'] },
  }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(job.status, 'dead_letter');
  assert.match(job.last_error, /421/);
  assert.equal((await s.repo.listPublications())[0].whatsapp_msg_id, job.whatsapp_message_id);
  await s.queue.init();
  await s.process();
  assert.equal((await s.repo.getQueueStats()).dead_letter, 1);
});

test('recibo da oferta 23 não confirma outra oferta do mesmo grupo', async () => {
  const s = await setup(async (jid, content, opts) => ({key: {remoteJid: jid, fromMe: true, id: opts.messageId}}));
  await s.process();
  const original = s.repo._memory.queueJobs[0];
  const second = await s.repo.enqueueJob({
    idempotencyKey: 'hunter:2:' + group, destinationJid: group, payload: {text: 'Oferta 2'},
  });
  await s.repo.markJobProcessing(second.job.id);
  await s.repo.reserveWhatsAppMessage(second.job.id, 'message-23');
  assert.equal(await s.repo.recordWhatsAppReceipt(group, 'message-23'), true);
  assert.equal(original.status, 'awaiting_receipt');
  assert.equal((await s.repo.getQueueStats()).delivered, 1);
  assert.equal((await s.repo.getQueueStats()).awaiting_receipt, 1);
});

test('reinício preserva oferta aguardando recibo sem recolocá-la na fila de envio', async () => {
  let calls = 0;
  const s = await setup(async () => { calls++; return {key:{id:'msg'}}; });
  await s.process();
  assert.equal(await s.repo.recoverStaleProcessingJobs(), 0);
  assert.equal((await s.repo.listReadyJobsByDestination()).length, 0);
  assert.equal(calls, 1);
});

test('produtos iguais de vendedores diferentes não são enviados novamente', async () => {
  const { similarProductTitles } = require('../src/services/queue/dispatcher');
  assert.equal(similarProductTitles('Cesto Organizador para Cozinha Mercado e Casa', 'Cesto Organizador para Cozinha Mercado e Casa'), true);
  assert.equal(similarProductTitles('Cesto Organizador Cozinha com Tampa Grande', 'Cesto organizador cozinha com tampa grande promoção'), true);
  assert.equal(similarProductTitles('Cesto Organizador Cozinha com Tampa Grande', 'Lápis de Cor Escolar 12 Cores'), false);
  const s = await setup(async () => { throw new Error('Não deveria enviar produto repetido'); });
  const prior = await s.repo.createOffer({ title: 'Cesto Organizador para Cozinha Mercado e Casa', sourceType: 'hunter', affiliateUrl: 'https://example.org/a', formattedMessage: 'Oferta', dedupHash: 'a' });
  const current = await s.repo.createOffer({ title: 'Cesto Organizador para Cozinha Mercado e Casa', sourceType: 'hunter', affiliateUrl: 'https://example.org/b', formattedMessage: 'Oferta', dedupHash: 'b' });
  const old = await s.repo.enqueueJob({ offerId: prior.id, destinationJid: group, payload: {text: 'Oferta'}, idempotencyKey: 'old' });
  await s.repo.markJobSent(old.job.id, 'old-message');
  s.repo._memory.queueJobs[0].offer_id = current.id;
  await s.process();
  assert.equal(s.repo._memory.queueJobs[0].status, 'dead_letter');
  assert.match(s.repo._memory.queueJobs[0].last_error, /semelhante/);
});

test('produto bloqueado não é enviado mesmo com outra oferta', async () => {
  const s = await setup(async () => { throw new Error('Produto bloqueado não deve ser enviado'); });
  await s.repo.setSetting('blocked_product_terms', ['formex']);
  s.repo._memory.queueJobs[0].payload_json.text = 'Oferta FORMEX de outro vendedor';
  await s.process();
  assert.equal(s.repo._memory.queueJobs[0].status, 'dead_letter');
  assert.match(s.repo._memory.queueJobs[0].last_error, /bloqueado/);
});
