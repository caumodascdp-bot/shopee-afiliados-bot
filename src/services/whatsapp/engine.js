// ==============================================================================
// Motor WhatsApp Baileys — Reaproveitado do TITAN CRM com Isolamento Total
// Adaptado de src/whatsapp/engines/baileys/connection.js, messaging.js e grupos_crm.js
// ==============================================================================

const EventEmitter = require('events');
const pino = require('pino');
const qrcode = require('qrcode');
const { groupDiagnostics } = require('./delivery_diagnostics');
const logger = require('../../utils/logger');
const { sleep } = require('../../utils/delay');
const MessageNormalizer = require('./message_normalizer');
const { usePostgresAuthState } = require('./pg_auth_state');
const {
  createOwnerIdentity,
  acquireSessionLock,
  renewSessionLock,
  releaseSessionLock,
  RENEW_INTERVAL_MS,
} = require('./session_lock');
const { validateAllowedHttpsUrl, SHOPEE_PRODUCT_HOSTS } = require('../../utils/url_validator');

const MAX_RECONNECT_ATTEMPTS = 15;
const JID_GRUPO_REGEX = /^\d{5,30}(?:-\d{5,30})?@g\.us$/;
const IMAGE_ALLOWED_HOSTS = new Set(['down-br.img.susercontent.com', 'cf.shopee.com.br', 'susercontent.com']);
const IMAGE_ALLOWED_SUFFIXES = ['.susercontent.com', '.shopee.com.br'];

function isValidGroupJid(jid) {
  return typeof jid === 'string' && JID_GRUPO_REGEX.test(jid);
}

// Lógica anti-loop reaproveitada exatamente de TITANCRM/src/whatsapp/engines/baileys/connection.js
function determineReconnectDecision({ statusCode, creds, DisconnectReason }) {
  const loggedOutCode = DisconnectReason?.loggedOut ?? 401;
  const replacedCode = DisconnectReason?.connectionReplaced ?? 440;
  const isLoggedOut = statusCode === loggedOutCode || statusCode === 401;
  const isReplaced = statusCode === replacedCode || statusCode === 440;
  const hasAuthenticatedCreds = Boolean(creds?.me?.id || creds?.registered);
  const isWaitingAuth = !hasAuthenticatedCreds && !isLoggedOut && !isReplaced;
  const shouldReconnect = !isLoggedOut && !isReplaced && hasAuthenticatedCreds;

  return {
    isLoggedOut,
    isReplaced,
    hasAuthenticatedCreds,
    isWaitingAuth,
    shouldReconnect,
  };
}

class WhatsAppEngine extends EventEmitter {
  constructor({
    repository,
    redis,
    cryptoHelper,
    encryptionKey = '',
    sessionId = 'shopee_principal',
    machineId = 'shopee-node-1',
    isProduction = false,
    baileysLoader = null,
  } = {}) {
    super();
    this.repository = repository;
    this.redis = redis;
    this.crypto = cryptoHelper;
    this.encryptionKey = encryptionKey;
    this.sessionId = sessionId;
    this.isProduction = isProduction;
    this.owner = createOwnerIdentity(machineId);
    this.baileysLoader = baileysLoader || (() => require('@whiskeysockets/baileys'));

    this.sock = null;
    this.authState = null;
    this.status = 'OFFLINE';
    this.phone = null;
    this.qrDataUrl = null;
    this.qrRaw = null;
    this.lastError = null;
    this.connectedAt = null;
    this.reconnectAttempts = 0;

    this._openingPromise = null;
    this._reconnectTimer = null;
    this._qrTimer = null;
    this._lockRenewTimer = null;
    this._lockRetryTimer = null;
    this._sentMessageIds = new Set();
    this._processedMessageIds = new Set();
    this._baileysLogger = pino({ level: 'silent' });
  }

  _markSentId(msgId) {
    if (!msgId) return;
    this._sentMessageIds.add(msgId);
    this._processedMessageIds.add(msgId);
    if (this._sentMessageIds.size > 5000) {
      const first = this._sentMessageIds.values().next().value;
      this._sentMessageIds.delete(first);
    }
    if (this._processedMessageIds.size > 10000) {
      const first = this._processedMessageIds.values().next().value;
      this._processedMessageIds.delete(first);
    }
  }

  _emitState() {
    this.emit('status', this.getStatus());
  }

  getStatus() {
    return {
      sessionId: this.sessionId,
      status: this.status,
      connected: this.status === 'CONNECTED',
      phone: this.phone,
      qrDataUrl: this.qrDataUrl,
      lastError: this.lastError,
      connectedAt: this.connectedAt,
      reconnectAttempts: this.reconnectAttempts,
      hasSocket: Boolean(this.sock),
    };
  }

  async connect({ isRetry = false } = {}) {
    if (this._openingPromise) {
      return this._openingPromise;
    }
    this._openingPromise = this._openSession({ isRetry }).finally(() => {
      this._openingPromise = null;
    });
    return this._openingPromise;
  }

  async _openSession({ isRetry = false } = {}) {
    if (!isRetry) {
      this._clearTimers();
      this.reconnectAttempts = 0;
    }

    // Fecha socket anterior com marca __substituido (padrão anti-race do TITAN)
    if (this.sock) {
      try {
        const old = this.sock;
        old.__substituido = true;
        this.sock = null;
        old.ws?.close?.();
        old.end?.();
      } catch (_) {}
    }

    // Trava distribuída no Redis para evitar dois processos com a mesma sessão
    try {
      const lock = await acquireSessionLock(this.redis, this.sessionId, { me: this.owner });
      if (!lock.ok) {
        this.status = 'LOCKED_BY_OTHER_INSTANCE';
        this.lastError = `Sessão em uso por outra instância (${lock.reason}). Nova tentativa em ${Math.round(lock.retryAfterMs / 1000)}s.`;
        this._emitState();
        this._lockRetryTimer = setTimeout(() => {
          this.connect({ isRetry: true }).catch(() => {});
        }, lock.retryAfterMs);
        if (typeof this._lockRetryTimer.unref === 'function') this._lockRetryTimer.unref();
        return this.getStatus();
      }
    } catch (err) {
      logger.warn('[WHATSAPP] Erro ao verificar trava de sessão:', err.message);
    }

    const baileys = this.baileysLoader();
    const {
      default: makeWASocket,
      DisconnectReason,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
      Browsers,
      proto,
    } = baileys;

    this.authState = await usePostgresAuthState({
      repository: this.repository,
      cryptoHelper: this.crypto,
      encryptionKey: this.encryptionKey,
      sessionId: this.sessionId,
      isProduction: this.isProduction,
      baileysHelpers: baileys,
    });

    const { version } = await fetchLatestBaileysVersion();
    this.status = 'INITIALIZING';
    this.lastError = null;
    this._emitState();

    const sock = makeWASocket({
      version,
      logger: this._baileysLogger,
      printQRInTerminal: false,
      browser: Browsers ? Browsers.windows('Chrome') : ['Chrome (Linux)', '', ''],
      qrTimeout: 90000,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: ({ syncType }) => {
        const fullCode = proto?.HistorySync?.HistorySyncType?.FULL;
        return fullCode === undefined ? true : syncType !== fullCode;
      },
      keepAliveIntervalMs: 25000,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 60000,
      retryRequestDelayMs: 250,
      auth: {
        creds: this.authState.state.creds,
        keys: makeCacheableSignalKeyStore
          ? makeCacheableSignalKeyStore(this.authState.state.keys, this._baileysLogger)
          : this.authState.state.keys,
      },
    });

    this.inspectGroup = groupDiagnostics(sock, logger, this.repository);
    this.sock = sock;
    this._startLockRenewTimer(sock);

    sock.ev.on('creds.update', async () => {
      try {
        await this.authState.saveCreds();
      } catch (err) {
        logger.error('[WHATSAPP] Erro ao salvar credenciais no PostgreSQL:', err.message);
      }
    });

    sock.ev.on('connection.update', async (update) => {
      if (sock.__substituido) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qrRaw = qr;
        this.qrDataUrl = await qrcode.toDataURL(qr, { width: 320, margin: 2 }).catch(() => null);
        this.status = 'QR_CODE';
        this.lastError = null;
        logger.info('[WHATSAPP] QR Code gerado e disponível no painel.');
        this._emitState();

        if (!this._qrTimer) {
          const hadCredsBeforeQr = this.authState.hasAuthenticatedCreds();
          this._qrTimer = setTimeout(async () => {
            this._qrTimer = null;
            if (sock.__substituido || this.sock !== sock) return;
            if (this.status !== 'CONNECTED') {
              try {
                sock.end?.(new Error('QR Timeout'));
              } catch (_) {}
              if (!hadCredsBeforeQr) {
                await this.authState.clearState().catch(() => {});
              }
              this.sock = null;
              this.qrDataUrl = null;
              this.qrRaw = null;
              this.status = 'TIMEOUT';
              this.lastError = 'Tempo limite de leitura do QR Code expirado. Clique em Conectar para gerar outro.';
              this._emitState();
            }
          }, 5 * 60 * 1000);
          if (typeof this._qrTimer.unref === 'function') this._qrTimer.unref();
        }
      }

      if (connection === 'open') {
        if (this._qrTimer) {
          clearTimeout(this._qrTimer);
          this._qrTimer = null;
        }
        this.reconnectAttempts = 0;
        this.qrDataUrl = null;
        this.qrRaw = null;
        this.lastError = null;
        this.status = 'CONNECTED';
        this.connectedAt = new Date().toISOString();
        this.phone = sock.user?.id ? String(sock.user.id).split(':')[0].split('@')[0] : null;
        logger.info(`[WHATSAPP] Conectado com sucesso. Número: ${this.phone || 'desconhecido'}`);
        this._emitState();
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMsg = lastDisconnect?.error?.message || `Código ${statusCode || 'desconhecido'}`;
        const decision = determineReconnectDecision({
          statusCode,
          creds: this.authState?.state?.creds,
          DisconnectReason,
        });

        this._stopLockRenewTimer();
        if (this.sock === sock) this.sock = null;
        await releaseSessionLock(this.redis, this.sessionId, this.owner).catch(() => {});

        if (sock.__substituido) return;

        if (decision.isLoggedOut) {
          this.reconnectAttempts = 0;
          this.phone = null;
          this.qrDataUrl = null;
          this.status = 'LOGGED_OUT';
          this.lastError = 'Sessão desconectada no celular (401/loggedOut). Leia um novo QR Code.';
          await this.authState.clearState().catch(() => {});
          logger.warn('[WHATSAPP] Sessão encerrada pelo celular (401). Credenciais limpas.');
          this._emitState();
        } else if (decision.isReplaced) {
          this.reconnectAttempts = 0;
          this.status = 'REPLACED';
          this.lastError = 'Conexão substituída por outro login no mesmo número (440).';
          logger.warn('[WHATSAPP] Conexão substituída (440). Reconexão interrompida.');
          this._emitState();
        } else if (decision.isWaitingAuth) {
          this.reconnectAttempts = 0;
          this.status = 'AWAITING_QR';
          this.lastError = errMsg;
          this._emitState();
        } else if (decision.shouldReconnect) {
          if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            this.status = 'FAILED_MAX_RETRIES';
            this.lastError = `Limite de ${MAX_RECONNECT_ATTEMPTS} tentativas de reconexão atingido (${errMsg}).`;
            logger.error(`[WHATSAPP] ${this.lastError}`);
            this._emitState();
            return;
          }
          this.reconnectAttempts += 1;
          const jitter = Math.floor(Math.random() * 1000);
          const delayMs = Math.min(2000 * Math.pow(1.5, Math.min(this.reconnectAttempts, 6)) + jitter, 30000);
          this.status = 'RECONNECTING';
          this.lastError = `Conexão interrompida (${errMsg}). Reconectando em ${Math.round(delayMs / 1000)}s...`;
          this._emitState();
          this._reconnectTimer = setTimeout(() => {
            this.connect({ isRetry: true }).catch((e) => {
              logger.error('[WHATSAPP] Falha na reconexão:', e.message);
            });
          }, delayMs);
          if (typeof this._reconnectTimer.unref === 'function') this._reconnectTimer.unref();
        } else {
          this.status = 'OFFLINE';
          this.lastError = errMsg;
          this._emitState();
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      for (const m of messages || []) {
        if (!m || !m.message) continue;
        const remoteJid = m.key?.remoteJid || '';
        if (!remoteJid || remoteJid === 'status@broadcast') continue;

        const msgId = m.key?.id || '';
        if (msgId && (this._processedMessageIds.has(msgId) || this._sentMessageIds.has(msgId))) continue;
        if (msgId) this._processedMessageIds.add(msgId);

        const text = MessageNormalizer.extractText(m.message);
        const canonicalType = MessageNormalizer.detectCanonicalType(m.message);
        const isGroup = isValidGroupJid(remoteJid);

        this.emit('message', {
          id: msgId,
          remoteJid,
          isGroup,
          fromMe: Boolean(m.key?.fromMe),
          participant: m.key?.participant || m.key?.participantAlt || '',
          pushName: m.pushName || '',
          type: canonicalType,
          text,
          raw: m,
        });
      }
    });

    return this.getStatus();
  }

  _startLockRenewTimer(sock) {
    this._stopLockRenewTimer();
    this._lockRenewTimer = setInterval(() => {
      if (this.sock !== sock) {
        this._stopLockRenewTimer();
        return;
      }
      renewSessionLock(this.redis, this.sessionId, this.owner).catch(() => {});
    }, RENEW_INTERVAL_MS);
    if (typeof this._lockRenewTimer.unref === 'function') this._lockRenewTimer.unref();
  }

  _stopLockRenewTimer() {
    if (this._lockRenewTimer) {
      clearInterval(this._lockRenewTimer);
      this._lockRenewTimer = null;
    }
  }

  _clearTimers() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._qrTimer) {
      clearTimeout(this._qrTimer);
      this._qrTimer = null;
    }
    if (this._lockRetryTimer) {
      clearTimeout(this._lockRetryTimer);
      this._lockRetryTimer = null;
    }
    this._stopLockRenewTimer();
  }

  async disconnect() {
    this._clearTimers();
    if (this.sock) {
      const s = this.sock;
      s.__substituido = true;
      this.sock = null;
      try {
        s.ws?.close?.();
        s.end?.();
      } catch (_) {}
    }
    await releaseSessionLock(this.redis, this.sessionId, this.owner).catch(() => {});
    this.status = 'OFFLINE';
    this.qrDataUrl = null;
    this.qrRaw = null;
    this._emitState();
    return this.getStatus();
  }

  async switchNumber() {
    await this.disconnect();
    if (this.sock?.logout) {
      try {
        await this.sock.logout();
      } catch (_) {}
    }
    await this.repository.clearBaileysAuthSession(this.sessionId);
    this.phone = null;
    this.lastError = null;
    return this.connect({ isRetry: false });
  }

  async restoreIfAuthenticated() {
    const existing = await this.repository.getBaileysAuthEntry(this.sessionId, 'creds', 'main');
    if (existing && existing.payload_encrypted) {
      logger.info('[WHATSAPP] Credenciais persistidas encontradas no banco. Restaurando sessão automaticamente...');
      return this.connect({ isRetry: false });
    }
    return this.getStatus();
  }

  async listGroups() {
    if (!this.sock || this.status !== 'CONNECTED') {
      throw new Error('WhatsApp não conectado. Conecte antes de listar os grupos.');
    }
    const participating = await this.sock.groupFetchAllParticipating();
    return Object.values(participating || {})
      .filter((g) => g && isValidGroupJid(g.id))
      .map((g) => ({
        jid: g.id,
        name: g.subject || g.id,
        participantsCount: Array.isArray(g.participants) ? g.participants.length : 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async sendTyping(jid, durationMs = 2000) {
    if (!this.sock || this.status !== 'CONNECTED') return;
    try {
      await this.sock.sendPresenceUpdate('composing', jid);
      await sleep(durationMs);
      await this.sock.sendPresenceUpdate('paused', jid);
    } catch (_) {}
  }

  async prepareGroupText(jid) {
    const sock = this.sock;
    if (!sock || this.status !== 'CONNECTED') throw new Error('WhatsApp desconectado.');
    const metadata = await sock.groupMetadata(jid);
    const normalize = value => value?.replace(/:\d+@/, '@');
    const own = [sock.user?.id, sock.user?.lid].filter(Boolean).map(normalize);
    const member = metadata.participants.find(p =>
      [p.id, p.phoneNumber, p.lid].some(id => own.includes(normalize(id))));
    if (metadata.announce && !['admin', 'superadmin'].includes(member?.admin)) {
      throw new Error('Envio não permitido: grupo exclusivo para administradores.');
    }
    const messageId = this.baileysLoader().generateMessageIDV2(sock.user?.id);
    return { messageId, send: async text => {
      const sent = await sock.sendMessage(jid, { text, linkPreview: null }, { messageId });
      if (sent?.key?.id !== messageId) throw new Error('Resposta sem o identificador reservado.');
      this._markSentId(messageId);
    } };
  }

  async sendText(jid, text) {
    if (!this.sock || this.status !== 'CONNECTED') {
      throw new Error('WhatsApp desconectado.');
    }
    if (!text || !String(text).trim()) {
      throw new Error('Texto da mensagem não pode estar vazio.');
    }
    void this.inspectGroup?.(jid);
    const sent = await this.sock.sendMessage(jid, { text: String(text) });
    const msgId = sent?.key?.id || '';
    this._markSentId(msgId);
    return { messageId: msgId };
  }

  async sendImage(jid, imageSource, caption = '') {
    if (!this.sock || this.status !== 'CONNECTED') {
      throw new Error('WhatsApp desconectado.');
    }
    let imagePayload;
    if (Buffer.isBuffer(imageSource)) {
      imagePayload = imageSource;
    } else if (typeof imageSource === 'string') {
      const safeUrl = validateAllowedHttpsUrl(imageSource, IMAGE_ALLOWED_HOSTS, {
        allowSuffixes: IMAGE_ALLOWED_SUFFIXES,
      });
      imagePayload = { url: safeUrl };
    } else {
      throw new Error('Fonte de imagem inválida.');
    }
    void this.inspectGroup?.(jid);
    const sent = await this.sock.sendMessage(jid, {
      image: imagePayload,
      caption: String(caption || ''),
    });
    const msgId = sent?.key?.id || '';
    this._markSentId(msgId);
    return { messageId: msgId };
  }

  async downloadImageBuffer(rawMsg) {
    if (!rawMsg || !rawMsg.message) return null;
    const type = MessageNormalizer.detectCanonicalType(rawMsg.message);
    if (type !== 'image') return null;
    const { downloadMediaMessage } = this.baileysLoader();
    if (typeof downloadMediaMessage !== 'function') return null;
    const buffer = await downloadMediaMessage(
      rawMsg,
      'buffer',
      {},
      {
        logger: this._baileysLogger,
        reuploadRequest: this.sock?.updateMediaMessage,
      }
    );
    // Limite de segurança de 8 MB em memória para evitar pico no Render/Android
    if (Buffer.isBuffer(buffer) && buffer.length > 0 && buffer.length <= 8 * 1024 * 1024) {
      return buffer;
    }
    return null;
  }
}

module.exports = {
  WhatsAppEngine,
  determineReconnectDecision,
  isValidGroupJid,
  MAX_RECONNECT_ATTEMPTS,
  SHOPEE_PRODUCT_HOSTS,
};
