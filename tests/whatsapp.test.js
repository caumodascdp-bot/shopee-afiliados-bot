const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const cryptoHelper = require('../src/utils/crypto');
const { Repository } = require('../src/database/repository');
const { RedisClient } = require('../src/redis/client');
const MessageNormalizer = require('../src/services/whatsapp/message_normalizer');
const { usePostgresAuthState } = require('../src/services/whatsapp/pg_auth_state');
const { acquireSessionLock, releaseSessionLock, evaluateLock } = require('../src/services/whatsapp/session_lock');
const { WhatsAppEngine, determineReconnectDecision, isValidGroupJid } = require('../src/services/whatsapp/engine');

test('WhatsApp: carrega pacote real @whiskeysockets/baileys sem erro ESM/CJS', () => {
  const baileys = require('@whiskeysockets/baileys');
  assert.equal(typeof baileys.default, 'function');
  assert.equal(typeof baileys.initAuthCreds, 'function');
  assert.equal(typeof baileys.BufferJSON?.replacer, 'function');
});

test('WhatsApp: MessageNormalizer extrai texto de conversation, extendedText, legenda e ephemeral', () => {
  assert.equal(MessageNormalizer.extractText({ conversation: '  Oferta 1  ' }), 'Oferta 1');
  assert.equal(
    MessageNormalizer.extractText({ extendedTextMessage: { text: 'Link: https://shopee.com.br/x' } }),
    'Link: https://shopee.com.br/x'
  );
  assert.equal(
    MessageNormalizer.extractText({ ephemeralMessage: { message: { imageMessage: { caption: 'Foto promo' } } } }),
    'Foto promo'
  );
  assert.equal(
    MessageNormalizer.detectCanonicalType({ ephemeralMessage: { message: { imageMessage: { caption: 'x' } } } }),
    'image'
  );
});

test('WhatsApp: determineReconnectDecision previne loop de QR e trata 401/440', () => {
  assert.equal(determineReconnectDecision({ statusCode: 401, creds: { registered: true } }).isLoggedOut, true);
  assert.equal(determineReconnectDecision({ statusCode: 440, creds: { registered: true } }).isReplaced, true);
  assert.equal(determineReconnectDecision({ statusCode: 408, creds: {} }).isWaitingAuth, true);
  assert.equal(determineReconnectDecision({ statusCode: 408, creds: {} }).shouldReconnect, false);
  assert.equal(determineReconnectDecision({ statusCode: 503, creds: { registered: true } }).shouldReconnect, true);
});

test('WhatsApp: persistência Baileys criptografada AES-256-GCM sobrevive ao reinício e rejeita corrupção/chave errada', async () => {
  const repository = new Repository();
  const encKey = 'chave-sessao-muito-forte-2026!';
  const helpers = {
    initAuthCreds: () => ({ registered: true, me: { id: '5511988887777@s.whatsapp.net' }, noiseKey: Buffer.from('abc') }),
    BufferJSON: require('@whiskeysockets/baileys').BufferJSON,
    proto: require('@whiskeysockets/baileys').proto,
  };

  const auth1 = await usePostgresAuthState({
    repository,
    cryptoHelper,
    encryptionKey: encKey,
    sessionId: 'sessao_teste',
    isProduction: true,
    baileysHelpers: helpers,
  });

  await auth1.state.keys.set({ 'pre-key': { '1': { private: Buffer.from('priv1') } } });
  await auth1.saveCreds();

  // Confirma que no banco o payload está criptografado (não em texto claro)
  const rawRow = await repository.getBaileysAuthEntry('sessao_teste', 'creds', 'main');
  assert.ok(rawRow.payload_encrypted.startsWith('v1:'));
  assert.ok(!rawRow.payload_encrypted.includes('5511988887777'));

  // Simula reinicialização criando nova instância lendo do banco
  const auth2 = await usePostgresAuthState({
    repository,
    cryptoHelper,
    encryptionKey: encKey,
    sessionId: 'sessao_teste',
    isProduction: true,
    baileysHelpers: helpers,
  });
  assert.equal(auth2.hasAuthenticatedCreds(), true);
  assert.equal(auth2.state.creds.me.id, '5511988887777@s.whatsapp.net');
  const loadedKeys = await auth2.state.keys.get('pre-key', ['1']);
  assert.equal(Buffer.from(loadedKeys['1'].private).toString(), 'priv1');

  // Chave errada deve falhar explicitamente (proteção contra corrupção/adulteração)
  await assert.rejects(
    () =>
      usePostgresAuthState({
        repository,
        cryptoHelper,
        encryptionKey: 'outra-chave-completamente-errada',
        sessionId: 'sessao_teste',
        isProduction: true,
        baileysHelpers: helpers,
      }),
    /corrompida|incompatível/
  );
});

test('WhatsApp: trava distribuída no Redis impede dois processos simultâneos na mesma sessão', async () => {
  const redis = new RedisClient({ isTest: true });
  const ownerA = { node: 'node-1', pid: 1001, machine: 'm1', host: 'h1', boot: 'b1', serialized: JSON.stringify({ node: 'node-1', pid: 1001, machine: 'm1', host: 'h1', boot: 'b1' }) };
  const ownerB = { node: 'node-2', pid: 1002, machine: 'm2', host: 'h2', boot: 'b2', serialized: JSON.stringify({ node: 'node-2', pid: 1002, machine: 'm2', host: 'h2', boot: 'b2' }) };

  const lockA = await acquireSessionLock(redis, 'shopee_principal', { me: ownerA });
  assert.equal(lockA.ok, true);

  const lockB = await acquireSessionLock(redis, 'shopee_principal', { me: ownerB });
  assert.equal(lockB.ok, false);

  await releaseSessionLock(redis, 'shopee_principal', ownerA);
  const lockB2 = await acquireSessionLock(redis, 'shopee_principal', { me: ownerB });
  assert.equal(lockB2.ok, true);

  // Processo morto na mesma máquina tem trava retomada automaticamente
  const evalDead = evaluateLock(ownerA.serialized, { ...ownerA, pid: 9999 }, { checkPidAlive: () => false });
  assert.equal(evalDead.action, 'take');
});

test('WhatsApp: engine gera QR Code, conecta, lista grupos, envia texto/imagem e reconhece mensagens', async () => {
  const repository = new Repository();
  const redis = new RedisClient({ isTest: true });
  const sentPayloads = [];
  const fakeSock = {
    ev: new EventEmitter(),
    ws: { close() {} },
    end() {},
    user: { id: '5511977776666:1@s.whatsapp.net' },
    async sendMessage(jid, content) {
      sentPayloads.push({ jid, content });
      return { key: { id: `WA_${sentPayloads.length}` } };
    },
    async groupFetchAllParticipating() {
      return {
        '120363000000000111@g.us': { id: '120363000000000111@g.us', subject: 'Ofertas Origem', participants: [1, 2] },
        'invalido@c.us': { id: 'invalido@c.us', subject: 'Ignorar' },
      };
    },
  };

  const engine = new WhatsAppEngine({
    repository,
    redis,
    cryptoHelper,
    encryptionKey: 'chave-teste-engine-123456',
    sessionId: 'teste_engine',
    baileysLoader: () => ({
      default: () => fakeSock,
      DisconnectReason: { loggedOut: 401, connectionReplaced: 440 },
      fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
      makeCacheableSignalKeyStore: (k) => k,
      Browsers: { windows: () => ['Win', 'Chrome', '10'] },
      initAuthCreds: () => ({}),
      BufferJSON: require('@whiskeysockets/baileys').BufferJSON,
      proto: require('@whiskeysockets/baileys').proto,
    }),
  });

  await engine.connect();
  const waitForStatus = (target) =>
    new Promise((resolve) => {
      if (engine.getStatus().status === target && (target !== 'QR_CODE' || engine.getStatus().qrDataUrl)) {
        return resolve(engine.getStatus());
      }
      const onSt = (st) => {
        if (st.status === target && (target !== 'QR_CODE' || st.qrDataUrl)) {
          engine.off('status', onSt);
          resolve(st);
        }
      };
      engine.on('status', onSt);
    });

  const qrWait = waitForStatus('QR_CODE');
  fakeSock.ev.emit('connection.update', { qr: '2@fake_qr_code_payload' });
  await qrWait;
  assert.equal(engine.getStatus().status, 'QR_CODE');
  assert.ok(engine.getStatus().qrDataUrl.startsWith('data:image/png;base64,'));

  const openWait = waitForStatus('CONNECTED');
  fakeSock.ev.emit('connection.update', { connection: 'open' });
  await openWait;
  assert.equal(engine.getStatus().connected, true);
  assert.equal(engine.getStatus().phone, '5511977776666');

  const groups = await engine.listGroups();
  assert.equal(groups.length, 1);
  assert.equal(isValidGroupJid(groups[0].jid), true);

  await engine.sendText('120363000000000111@g.us', 'Mensagem de teste');
  await engine.sendImage('120363000000000111@g.us', Buffer.from('img'), 'Foto teste');
  assert.equal(sentPayloads.length, 2);
  assert.ok(Buffer.isBuffer(sentPayloads[1].content.image));

  const received = [];
  engine.on('message', (m) => received.push(m));
  fakeSock.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [{ key: { id: 'IN_1', remoteJid: '120363000000000111@g.us', fromMe: false }, message: { conversation: 'Promo https://shope.ee/abc' } }],
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].isGroup, true);

  await engine.disconnect();
});
