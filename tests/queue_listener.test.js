const test = require('node:test');
const assert = require('node:assert/strict');
const { Repository } = require('../src/database/repository');
const { RedisClient } = require('../src/redis/client');
const { MessageDispatcher } = require('../src/services/queue/dispatcher');
const { GroupManager } = require('../src/services/groups/manager');
const { GroupListener } = require('../src/services/groups/listener');
const { OfferConverter } = require('../src/services/offers/converter');

test('Fila: processa sequencialmente por destino, garante idempotência, recupera jobs e trata erros', async () => {
  const repository = new Repository();
  const redis = new RedisClient({ isTest: true });
  const sent = [];

  let failNext = false;
  const whatsappMock = {
    status: 'CONNECTED',
    async sendTyping() {},
    async sendText(jid, text) {
      if (failNext) {
        failNext = false;
        throw new Error('Timeout temporário de rede');
      }
      sent.push({ jid, text });
      return { messageId: `MSG_${sent.length}` };
    },
    async sendImage(jid, _img, caption) {
      sent.push({ jid, text: caption, image: true });
      return { messageId: `IMG_${sent.length}` };
    },
  };

  const dispatcher = new MessageDispatcher({
    repository,
    redis,
    whatsapp: whatsappMock,
    config: { queueDelayMinMs: 0, queueDelayMaxMs: 0, typingDelayMinMs: 0, typingDelayMaxMs: 0, maxSendsPerMinute: 10, maxAttempts: 3 },
  });

  // Idempotência: mesma chave só enfileira uma vez
  const first = await dispatcher.enqueue({
    destinationJid: '120363000000000002@g.us',
    text: 'Oferta 1',
    idempotencyKey: 'chave-unica-1',
  });
  const dup = await dispatcher.enqueue({
    destinationJid: '120363000000000002@g.us',
    text: 'Oferta 1',
    idempotencyKey: 'chave-unica-1',
  });
  assert.equal(first.inserted, true);
  assert.equal(dup.inserted, false);

  // Simula erro temporário e recuperação
  failNext = true;
  await dispatcher.processPendingBatch({ skipDelay: true });
  let stats = await repository.getQueueStats();
  assert.equal(stats.failed, 1);

  // Força next_attempt_at para agora e reprocessa
  repository._memory.queueJobs[0].next_attempt_at = new Date(Date.now() - 1000).toISOString();
  await dispatcher.processPendingBatch({ skipDelay: true });
  stats = await repository.getQueueStats();
  assert.equal(stats.sent, 1);
  assert.equal(sent.length, 1);

  // Recuperação após reinicialização (job preso em processing volta a pending)
  const stuck = await dispatcher.enqueue({
    destinationJid: '120363000000000002@g.us',
    text: 'Oferta interrompida',
    idempotencyKey: 'chave-stuck',
  });
  await repository.markJobProcessing(stuck.job.id);
  const recoveredCount = await dispatcher.init();
  assert.equal(recoveredCount, 1);
});

test('Listener: bloqueia encaminhamento sem ativação explícita e encaminha com deduplicação quando autorizado', async () => {
  const repository = new Repository();
  const redis = new RedisClient({ isTest: true });
  const sent = [];

  const whatsappMock = {
    status: 'CONNECTED',
    on() {},
    off() {},
    async sendTyping() {},
    async sendText(jid, text) {
      sent.push({ jid, text });
      return { messageId: `M_${sent.length}` };
    },
    async sendImage(jid, img, caption) {
      sent.push({ jid, img, text: caption });
      return { messageId: `I_${sent.length}` };
    },
    async listGroups() {
      return [
        { jid: '120363000000000001@g.us', name: 'Grupo Fonte', participantsCount: 50 },
        { jid: '120363000000000002@g.us', name: 'Grupo Destino', participantsCount: 200 },
      ];
    },
  };

  const shopeeMock = {
    async resolveShopeeUrl(url) {
      return {
        originUrl: url,
        resolvedUrl: 'https://shopee.com.br/product/111/222',
        shopId: '111',
        itemId: '222',
        canonicalUrl: 'https://shopee.com.br/product/111/222',
      };
    },
    async getProductOffer() {
      return {
        itemId: '222',
        shopId: '111',
        title: 'Fone Bluetooth TWS',
        priceMin: 79.9,
        priceMax: 79.9,
        discountPercent: 40,
        commissionRate: 0.12,
        sales: 900,
        rating: 4.8,
        productUrl: 'https://shopee.com.br/product/111/222',
        imageUrl: 'https://down-br.img.susercontent.com/file/fone.jpg',
      };
    },
    async generateShortLink({ originUrl, subIds }) {
      return { originUrl, shortLink: 'https://shope.ee/afiliado222', subIds };
    },
  };

  const groupManager = new GroupManager({ repository, whatsapp: whatsappMock });
  await groupManager.syncGroupsFromWhatsApp();
  await groupManager.updateGroup('120363000000000001@g.us', { isSource: true });
  await groupManager.updateGroup('120363000000000002@g.us', { isDestination: true });

  const dispatcher = new MessageDispatcher({
    repository,
    redis,
    whatsapp: whatsappMock,
    config: { queueDelayMinMs: 0, queueDelayMaxMs: 0, typingDelayMinMs: 0, typingDelayMaxMs: 0, maxSendsPerMinute: 10 },
  });
  const converter = new OfferConverter({ shopeeClient: shopeeMock, repository });
  const listener = new GroupListener({
    whatsapp: whatsappMock,
    groupManager,
    shopeeClient: shopeeMock,
    converter,
    dispatcher,
    repository,
    redis,
  });

  // 1) Espelhamento DESLIGADO por padrão -> não enfileira nada
  await listener.handleIncomingMessage({
    id: 'MSG_1',
    remoteJid: '120363000000000001@g.us',
    isGroup: true,
    fromMe: false,
    type: 'text',
    text: 'Super oferta https://s.shopee.com.br/abc123',
  });
  assert.equal((await repository.getQueueStats()).pending, 0);

  // 2) Ativa espelhamento explícito -> converte, enfileira e envia
  await groupManager.setMirrorConfig({ enabled: true });
  await listener.handleIncomingMessage({
    id: 'MSG_2',
    remoteJid: '120363000000000001@g.us',
    isGroup: true,
    fromMe: false,
    type: 'text',
    text: 'Super oferta https://s.shopee.com.br/abc123',
  });
  assert.equal((await repository.getQueueStats()).pending, 1);

  // 3) Mesma oferta repetida logo em seguida -> ignorada por deduplicação
  await listener.handleIncomingMessage({
    id: 'MSG_3',
    remoteJid: '120363000000000001@g.us',
    isGroup: true,
    fromMe: false,
    type: 'text',
    text: 'Super oferta https://s.shopee.com.br/abc123',
  });
  assert.equal((await repository.getQueueStats()).pending, 1);

  await dispatcher.processPendingBatch({ skipDelay: true });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /https:\/\/shope\.ee\/afiliado222/);
});
