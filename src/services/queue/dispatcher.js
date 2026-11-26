// ==============================================================================
// Fila de Mensagens Persistente e Sequencial por Destino
// Lógica base aproveitada de gabrieldamasse-01/bot-de-automacao e evoluída com:
//   - Persistência durável no PostgreSQL (queue_jobs + publications_history)
//   - Locks distribuídos e rate limit conservador no Upstash Redis
//   - Recuperação automática de jobs após reinicialização
//   - Diferenciação de erros temporários vs permanentes
// ==============================================================================

const crypto = require('crypto');
const logger = require('../../utils/logger');
const { sleep, randomDelay, formatMs } = require('../../utils/delay');

function similarProductTitles(first, second) {
  const tokens = title => new Set(String(title || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().match(/[a-z0-9]+/g)?.filter(word => word.length > 2) || []);
  const left = tokens(first);
  const right = tokens(second);
  if (left.size < 3 || right.size < 3) return false;
  const common = [...left].filter(word => right.has(word)).length;
  return common / Math.max(left.size, right.size) >= 0.75;
}

function isPermanentSendError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('jid') ||
    msg.includes('fonte de imagem inválida') ||
    msg.includes('não permitido') ||
    msg.includes('not-authorized') ||
    msg.includes('forbidden') ||
    msg.includes('vazio')
  );
}

class MessageDispatcher {
  constructor({
    repository,
    redis,
    whatsapp,
    config = {},
  } = {}) {
    this.repository = repository;
    this.redis = redis;
    this.whatsapp = whatsapp;
    this.delayMinMs = Number(config.queueDelayMinMs) || 15000;
    this.delayMaxMs = Number(config.queueDelayMaxMs) || 45000;
    this.typingMinMs = Number(config.typingDelayMinMs) || 2000;
    this.typingMaxMs = Number(config.typingDelayMaxMs) || 5000;
    this.checkIntervalMs = Number(config.queueCheckIntervalMs) || 5000;
    this.maxSendsPerMinute = Number(config.maxSendsPerMinute) || 3;
    this.maxAttempts = Number(config.maxAttempts) || 3;

    this._running = false;
    this._loopPromise = null;
    this._activeDestinations = new Set();
  }

  async init() {
    const recovered = await this.repository.recoverStaleProcessingJobs();
    if (recovered > 0) {
      logger.warn(`[FILA] ${recovered} tarefa(s) recuperada(s) após reinicialização.`);
    }
    return recovered;
  }

  async enqueue({ offerId = null, destinationJid, text, imageUrl = '', imageBase64 = '', idempotencyKey = null }) {
    const key =
      idempotencyKey ||
      crypto
        .createHash('sha256')
        .update(`${destinationJid}|${offerId || ''}|${text}|${Date.now()}`)
        .digest('hex')
        .slice(0, 48);

    return this.repository.enqueueJob({
      idempotencyKey: key,
      offerId,
      destinationJid,
      payload: {
        text,
        imageUrl: imageUrl || '',
        imageBase64: imageBase64 || '',
      },
      maxAttempts: this.maxAttempts,
    });
  }

  async _canSendNow() {
    if (!this.redis) return true;
    const count = await this.redis.incrWithExpire('ratelimit:wa_sends_minute', 60);
    return count <= this.maxSendsPerMinute;
  }

  async processSingleJob(job, { skipDelay = false } = {}) {
    const dest = job.destination_jid;
    const destLockKey = `lock:queue_dest:${dest}`;
    const lockToken = `${process.pid}-${Date.now()}-${job.id}`;

    if (this._activeDestinations.has(dest)) {
      return { skipped: true, reason: 'local_busy' };
    }

    if (this.redis) {
      const acquired = await this.redis.setIfAbsent(destLockKey, lockToken, 90);
      if (!acquired) {
        return { skipped: true, reason: 'redis_dest_locked' };
      }
    }

    this._activeDestinations.add(dest);
    try {
      if (!(await this._canSendNow())) {
        return { skipped: true, reason: 'rate_limit_minute' };
      }

      const claimed = await this.repository.markJobProcessing(job.id);
      if (!claimed) {
        return { skipped: true, reason: 'already_claimed' };
      }

      if (claimed.offer_id && claimed.idempotency_key?.startsWith('hunter:')) {
        const titles = await this.repository.getOfferTitlesForDestination(claimed.offer_id, dest, claimed.id);
        if (titles.title && titles.previous.some(title => similarProductTitles(titles.title, title))) {
          await this.repository.markJobFailed(claimed.id, {
            errorMessage: 'Produto semelhante já enviado ou aguardando confirmação neste grupo.',
            permanent: true,
          });
          return { skipped: true, reason: 'similar_product' };
        }
      }

      const payload = claimed.payload_json || {};
      const text = String(payload.text || '').trim();
      if (!text) {
        await this.repository.markJobFailed(claimed.id, {
          errorMessage: 'Texto da oferta vazio.',
          permanent: true,
        });
        return { sent: false, permanent: true };
      }

      if (!skipDelay && this.typingMaxMs > 0) {
        const typingMs = await randomDelay(this.typingMinMs, this.typingMaxMs);
        await this.whatsapp.sendTyping(dest, Math.min(typingMs, 3000));
      }

      // As ofertas do caçador aguardam recibo de entrega do grupo.
      const verified = claimed.idempotency_key?.startsWith('hunter:') && dest.endsWith('@g.us');
      if (verified) {
        const image = payload.imageBase64 ? Buffer.from(payload.imageBase64, 'base64') : payload.imageUrl;
        const submission = await this.whatsapp.prepareGroupText(dest, image);
        if (!await this.repository.reserveWhatsAppMessage(claimed.id, submission.messageId)) {
          return { skipped: true, reason: 'already_reserved' };
        }
        try {
          await submission.send(text);
        } catch (err) {
          logger.warn(`[FILA] Resultado incerto no envio #${claimed.id}: ${err.message}`);
        }
        // O recibo pode chegar antes do retorno, depois de um timeout ou após reinício.
        // Nunca repetir a publicação apenas porque ainda falta confirmação.
        if (!skipDelay) await randomDelay(this.delayMinMs, this.delayMaxMs);
        return { submitted: true, messageId: submission.messageId };
      }

      let sendResult;
      if (payload.imageBase64) {
        const buf = Buffer.from(payload.imageBase64, 'base64');
        sendResult = await this.whatsapp.sendImage(dest, buf, text);
      } else if (payload.imageUrl) {
        try {
          sendResult = await this.whatsapp.sendImage(dest, payload.imageUrl, text);
        } catch (imgErr) {
          logger.warn(`[FILA] Imagem falhou (${imgErr.message}); enviando somente texto para ${dest}.`);
          sendResult = await this.whatsapp.sendText(dest, text);
        }
      } else {
        sendResult = await this.whatsapp.sendText(dest, text);
      }

      await this.repository.markJobSent(claimed.id, sendResult?.messageId || '');
      logger.info(`[FILA] Oferta enviada para ${dest} (job #${claimed.id}).`);

      if (!skipDelay && this.delayMinMs > 0) {
        const waitMs = await randomDelay(this.delayMinMs, this.delayMaxMs);
        logger.debug(`[FILA] Aguardando intervalo conservador de ${formatMs(waitMs)}...`);
      }
      return { sent: true, messageId: sendResult?.messageId || '' };
    } catch (err) {
      const permanent = isPermanentSendError(err);
      const attempt = (job.attempts || 0) + 1;
      const backoffMs = Math.pow(attempt, 2) * 10000;
      await this.repository.markJobFailed(job.id, {
        errorMessage: err.message,
        permanent,
        retryDelayMs: backoffMs,
      });
      logger.error(`[FILA] Falha no job #${job.id} (${permanent ? 'permanente' : 'temporário'}): ${err.message}`);
      return { sent: false, error: err.message, permanent };
    } finally {
      this._activeDestinations.delete(dest);
      if (this.redis) {
        await this.redis.deleteIfEquals(destLockKey, lockToken).catch(() => {});
      }
    }
  }

  async processPendingBatch({ skipDelay = false } = {}) {
    if (!this.whatsapp || this.whatsapp.status !== 'CONNECTED') {
      return { processed: 0, reason: 'whatsapp_disconnected' };
    }

    const ready = await this.repository.listReadyJobsByDestination(30);
    if (!ready.length) return { processed: 0 };

    // Pega apenas 1 job por destino nesta rodada para garantir processamento sequencial por destino
    const pickedPerDest = new Map();
    for (const job of ready) {
      if (!pickedPerDest.has(job.destination_jid)) {
        pickedPerDest.set(job.destination_jid, job);
      }
    }

    let processed = 0;
    for (const job of pickedPerDest.values()) {
      if (!this._running && !skipDelay) break;
      const res = await this.processSingleJob(job, { skipDelay });
      if (!res.skipped) processed += 1;
    }
    return { processed };
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._loopPromise = this._runLoop();
    logger.info('[FILA] Processador sequencial iniciado.');
  }

  async _runLoop() {
    while (this._running) {
      try {
        await this.processPendingBatch({ skipDelay: false });
      } catch (err) {
        logger.error('[FILA] Erro no loop da fila:', err.message);
      }
      if (!this._running) break;
      await sleep(this.checkIntervalMs);
    }
  }

  async stop() {
    this._running = false;
    if (this._loopPromise) {
      await Promise.race([this._loopPromise, sleep(3000)]);
      this._loopPromise = null;
    }
    logger.info('[FILA] Processador encerrado com segurança.');
  }
}

module.exports = { MessageDispatcher, isPermanentSendError, similarProductTitles };
