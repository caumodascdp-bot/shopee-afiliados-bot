// ==============================================================================
// Persistência Criptografada de Sessão Baileys no Neon PostgreSQL
// Garante durabilidade no Render (disco efêmero), criptografia AES-256-GCM em
// repouso, atualização atômica sequenciada por mutex e isolamento total do TITAN
// ==============================================================================

const logger = require('../../utils/logger');

function getBaileysAuthHelpers() {
  const b = require('@whiskeysockets/baileys');
  return {
    initAuthCreds: b.initAuthCreds,
    BufferJSON: b.BufferJSON,
    proto: b.proto,
  };
}

async function usePostgresAuthState({
  repository,
  cryptoHelper,
  encryptionKey,
  sessionId = 'shopee_principal',
  isProduction = false,
  baileysHelpers = null,
} = {}) {
  if (!repository) throw new Error('Repository obrigatório para persistência Baileys.');
  if (!cryptoHelper) throw new Error('CryptoHelper obrigatório para persistência Baileys.');
  if (isProduction && (!encryptionKey || String(encryptionKey).trim().length < 16)) {
    throw new Error('SESSION_ENCRYPTION_KEY obrigatória em produção para proteger a sessão Baileys.');
  }

  const { initAuthCreds, BufferJSON, proto } = baileysHelpers || getBaileysAuthHelpers();

  // Mutex simples para serializar gravações concorrentes de chaves do Baileys
  let writeMutex = Promise.resolve();
  const enqueueWrite = (fn) => {
    const next = writeMutex.then(fn, fn);
    writeMutex = next.catch(() => {});
    return next;
  };

  function encodeEntry(obj, keyType, keyId) {
    const serializedWithBuffers = JSON.stringify(obj, BufferJSON.replacer);
    const aad = `baileys:${sessionId}:${keyType}:${keyId}`;
    return cryptoHelper.encryptJson({ v: serializedWithBuffers }, encryptionKey, aad, { isProduction });
  }

  function decodeEntry(encryptedPayload, keyType, keyId) {
    const aad = `baileys:${sessionId}:${keyType}:${keyId}`;
    const decrypted = cryptoHelper.decryptJson(encryptedPayload, encryptionKey, aad, { isProduction });
    if (!decrypted || typeof decrypted.v !== 'string') {
      throw new Error('Conteúdo de sessão Baileys inválido após descriptografia.');
    }
    return JSON.parse(decrypted.v, BufferJSON.reviver);
  }

  async function readData(keyType, keyId) {
    const row = await repository.getBaileysAuthEntry(sessionId, keyType, keyId);
    if (!row || !row.payload_encrypted) return null;
    try {
      return decodeEntry(row.payload_encrypted, keyType, keyId);
    } catch (err) {
      logger.error(`[BAILEYS-AUTH] Falha ao ler/descriptografar ${keyType}:${keyId} — ${err.message}`);
      throw new Error(`Sessão WhatsApp corrompida ou SESSION_ENCRYPTION_KEY incompatível (${keyType}:${keyId}).`);
    }
  }

  let creds = await readData('creds', 'main');
  if (!creds) {
    creds = initAuthCreds();
    await enqueueWrite(() =>
      repository.saveBaileysAuthEntries(sessionId, [
        {
          keyType: 'creds',
          keyId: 'main',
          payloadEncrypted: encodeEntry(creds, 'creds', 'main'),
        },
      ])
    );
  }

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data = {};
        await Promise.all(
          (ids || []).map(async (id) => {
            let value = await readData(type, id);
            if (type === 'app-state-sync-key' && value && proto?.Message?.AppStateSyncKeyData) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          })
        );
        return data;
      },
      set: async (data) => {
        const batch = [];
        for (const category of Object.keys(data || {})) {
          const categoryMap = data[category] || {};
          for (const id of Object.keys(categoryMap)) {
            const value = categoryMap[id];
            if (value) {
              batch.push({
                keyType: category,
                keyId: id,
                payloadEncrypted: encodeEntry(value, category, id),
              });
            } else {
              batch.push({
                keyType: category,
                keyId: id,
                payloadEncrypted: null,
              });
            }
          }
        }
        if (batch.length > 0) {
          await enqueueWrite(() => repository.saveBaileysAuthEntries(sessionId, batch));
        }
      },
    },
  };

  async function saveCreds() {
    await enqueueWrite(() =>
      repository.saveBaileysAuthEntries(sessionId, [
        {
          keyType: 'creds',
          keyId: 'main',
          payloadEncrypted: encodeEntry(state.creds, 'creds', 'main'),
        },
      ])
    );
  }

  async function clearState() {
    await enqueueWrite(() => repository.clearBaileysAuthSession(sessionId));
  }

  function hasAuthenticatedCreds() {
    return Boolean(state.creds?.me?.id || state.creds?.registered);
  }

  return {
    state,
    saveCreds,
    clearState,
    hasAuthenticatedCreds,
  };
}

module.exports = { usePostgresAuthState };
