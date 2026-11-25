// ==============================================================================
// Agendador periódico do Caçador Automático
// ==============================================================================

const logger = require('../utils/logger');

class HunterScheduler {
  constructor({ hunter }) {
    this.hunter = hunter;
    this._timer = null;
    this._running = false;
    this._inFlight = false;
    this._failures = 0;
    this._retryAt = 0;
  }

  start() {
    if (this._running) return;
    this._running = true;
    // Verifica a cada 60s se atingiu o intervalo configurado e se o caçador está explicitamente ativo
    this._timer = setInterval(() => {
      this.tick().catch((err) => logger.error('[SCHEDULER] Erro no ciclo do caçador:', err.message));
    }, 60 * 1000);
    if (typeof this._timer.unref === 'function') this._timer.unref();
    logger.info('[SCHEDULER] Agendador do caçador iniciado (aguarda ativação explícita).');
  }

  async tick() {
    if (!this._running) return { skipped: true };
    if (this._inFlight) return { skipped: true, reason: 'in_flight' };
    if (Date.now() < this._retryAt) return { skipped: true, reason: 'retry_backoff' };
    this._inFlight = true;
    try {
      const cfg = await this.hunter.getConfig();
      if (!cfg.enabled) return { skipped: true, reason: 'disabled' };

      const intervalMs = Math.max(10, Number(cfg.intervalMinutes) || 60) * 60 * 1000;
      const lastMs = cfg.lastRunAt ? Date.parse(cfg.lastRunAt) : 0;
      if (lastMs && Date.now() - lastMs < intervalMs) {
        return { skipped: true, reason: 'interval_not_elapsed' };
      }
      const result = await this.hunter.runCycle({ forceManual: false });
      this._failures = 0;
      this._retryAt = 0;
      return result;
    } catch (err) {
      this._failures++;
      this._retryAt = Date.now() + Math.min(15 * 60 * 1000, 60 * 1000 * 2 ** Math.min(this._failures - 1, 4));
      throw err;
    } finally {
      this._inFlight = false;
    }
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

module.exports = { HunterScheduler };
