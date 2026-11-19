// ==============================================================================
// Medição Real de Consumo de Memória RAM nos 7 Cenários Exigidos (Meta ~300 MB)
// ==============================================================================

const EventEmitter = require('events');
const crypto = require('crypto');
const { createRuntime } = require('../index');

function snapshotMb(label) {
  const m = process.memoryUsage();
  return {
    cenario: label,
    rssMb: Math.round((m.rss / 1024 / 1024) * 100) / 100,
    heapUsedMb: Math.round((m.heapUsed / 1024 / 1024) * 100) / 100,
    heapTotalMb: Math.round((m.heapTotal / 1024 / 1024) * 100) / 100,
    externalMb: Math.round((m.external / 1024 / 1024) * 100) / 100,
  };
}

function makeFakeBaileys(sentMessages) {
  const sock = {
    ev: new EventEmitter(),
    ws: { close() {} },
    end() {},
    user: { id: '5511999998888:1@s.whatsapp.net' },
    async sendPresenceUpdate() {},
    async sendMessage(jid, content) {
      sentMessages.push({ jid, hasImage: Boolean(content.image) });
      return { key: { id: `MSG_${sentMessages.length}` } };
    },
    async groupFetchAllParticipating() {
      return {
        '120363000000000001@g.us': { id: '120363000000000001@g.us', subject: 'Grupo Fonte 1', participants: new Array(25) },
        '120363000000000002@g.us': { id: '120363000000000002@g.us', subject: 'Grupo Destino 1', participants: new Array(100) },
      };
    },
  };

  return {
    default: () => sock,
    DisconnectReason: { loggedOut: 401, connectionReplaced: 440 },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    makeCacheableSignalKeyStore: (keys) => keys,
    Browsers: { windows: () => ['Windows', 'Chrome', '10'] },
    initAuthCreds: () => ({ me: { id: '5511999998888@s.whatsapp.net' }, registered: true }),
    BufferJSON: {
      replacer: (_k, v) => v,
      reviver: (_k, v) => v,
    },
    proto: { HistorySync: { HistorySyncType: { FULL: 1 } } },
    _sock: sock,
  };
}

async function main() {
  const measurements = [];
  const encKey = crypto.randomBytes(24).toString('hex');

  // 1. Aplicação em repouso
  let runtime = await createRuntime({
    isTest: true,
    isProduction: false,
    sessionEncryptionKey: encKey,
    pingSecret: 'bench-ping-secret',
  });
  measurements.push(snapshotMb('1. Aplicação em repouso'));

  // 2. WhatsApp conectado (usando camada Baileys carregada)
  require('@whiskeysockets/baileys');
  const sent = [];
  const fakeBaileys = makeFakeBaileys(sent);
  runtime.whatsapp.baileysLoader = () => fakeBaileys;
  await runtime.whatsapp.connect();
  fakeBaileys._sock.ev.emit('connection.update', { connection: 'open' });
  await new Promise((r) => setTimeout(r, 20));
  await runtime.groupManager.syncGroupsFromWhatsApp();
  await runtime.groupManager.updateGroup('120363000000000001@g.us', { isSource: true });
  await runtime.groupManager.updateGroup('120363000000000002@g.us', { isDestination: true });
  await runtime.groupManager.setMirrorConfig({ enabled: true });
  measurements.push(snapshotMb('2. WhatsApp conectado + Baileys carregado'));

  // 3. Monitoramento de grupos (simula lote de mensagens no listener)
  runtime.shopeeClient.fetchImpl = async (_url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    if (body.query && body.query.includes('generateShortLink')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { generateShortLink: { shortLink: 'https://shope.ee/bench123' } } }),
      };
    }
    const nodes = Array.from({ length: 50 }, (_, i) => ({
      itemId: String(1000000 + i),
      shopId: '55555',
      productName: `Produto Teste Benchmark ${i + 1}`,
      shopName: 'Loja Oficial',
      productLink: `https://shopee.com.br/product/55555/${1000000 + i}`,
      offerLink: `https://shope.ee/item${i}`,
      priceMin: '89.90',
      priceMax: '129.90',
      priceDiscountRate: '30',
      commissionRate: '0.12',
      commission: '10.78',
      sales: 250 + i,
      ratingStar: '4.9',
      imageUrl: 'https://down-br.img.susercontent.com/file/br-test.jpg',
    }));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: { productOfferV2: { nodes, pageInfo: { page: 1, limit: 50, hasNextPage: false } } },
      }),
    };
  };

  await runtime.shopeeClient.saveCredentials({
    appId: '123456',
    secretKey: 'bench-secret',
    defaultSubId: 'bench',
  });

  runtime.listener.start();
  for (let i = 0; i < 15; i++) {
    await runtime.listener.handleIncomingMessage({
      id: `IN_${i}`,
      remoteJid: '120363000000000001@g.us',
      isGroup: true,
      fromMe: false,
      type: 'text',
      text: `Oferta imperdível R$ 99,90 https://shopee.com.br/product/55555/${200000 + i}`,
    });
  }
  measurements.push(snapshotMb('3. Monitoramento de grupos (15 ofertas processadas)'));

  // 4. Pesquisa Shopee (50 produtos normalizados + cache)
  await runtime.shopeeClient.searchProducts({ keyword: 'eletronicos', limit: 50, useCache: true });
  measurements.push(snapshotMb('4. Pesquisa Shopee (50 ofertas + cache)'));

  // 5. Envio de imagens (fila com buffers de 512 KB simulando fotos)
  const fakePhotoBase64 = crypto.randomBytes(512 * 1024).toString('base64');
  for (let i = 0; i < 5; i++) {
    await runtime.dispatcher.enqueue({
      destinationJid: '120363000000000002@g.us',
      text: `Envio com imagem #${i}`,
      imageBase64: fakePhotoBase64,
      idempotencyKey: `bench-img-${i}`,
    });
  }
  await runtime.dispatcher.processPendingBatch({ skipDelay: true });
  measurements.push(snapshotMb('5. Envio de imagens (buffer 512 KB na fila)'));

  // 6. Pico de processamento (caçador + múltiplos lotes simultâneos)
  await runtime.repository.addHunterKeyword({ keyword: 'smartwatch', minCommissionRate: 0.05 });
  await runtime.hunter.saveConfig({ enabled: true, maxPerRun: 5 });
  await runtime.hunter.runCycle({ forceManual: true });
  await runtime.dispatcher.processPendingBatch({ skipDelay: true });
  measurements.push(snapshotMb('6. Pico de processamento (Caçador + Fila + Cache)'));

  // 7. Recuperação após reinicialização
  runtime.listener.stop();
  await runtime.dispatcher.stop();
  await runtime.whatsapp.disconnect();
  await runtime.redisClient.close();
  await runtime.pgClient.close();
  runtime = null;
  if (typeof global.gc === 'function') global.gc();

  const restarted = await createRuntime({
    isTest: true,
    isProduction: false,
    sessionEncryptionKey: encKey,
    pingSecret: 'bench-ping-secret',
  });
  measurements.push(snapshotMb('7. Recuperação após reinicialização'));
  await restarted.dispatcher.stop();
  await restarted.redisClient.close();
  await restarted.pgClient.close();

  const peakRssMb = Math.max(...measurements.map((m) => m.rssMb));
  console.log(JSON.stringify({ metaMb: 300, peakRssMb, withinTarget: peakRssMb <= 300, measurements }, null, 2));
}

main().catch((err) => {
  console.error('MEASURE MEMORY FAILED:', err.message);
  process.exit(1);
});
