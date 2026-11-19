// ==============================================================================
// Caçador Automático de Ofertas Shopee (Piloto Automático Configurável)
// Só utiliza filtros cujos dados a Open API oficial (productOfferV2) retorna.
// Nunca dispara automaticamente sem ativação explícita no painel.
// ==============================================================================

const crypto = require('crypto');
const logger = require('../../utils/logger');
const { formatOfferMessage, scoreOffer } = require('../shopee/formatter');

const DEFAULT_HUNTER_CONFIG = {
  enabled: false,
  intervalMinutes: 60,
  minCommissionPercent: 5,
  minPrice: 0,
  maxPrice: 0,
  minSales: 0,
  maxPerRun: 3,
  sortType: 5, // 5 = maior comissão na API Shopee
  destinationJids: [],
  subId: 'cacador_auto',
  lastRunAt: null,
  lastRunSummary: null,
};

class OfferHunter {
  constructor({ repository, redis, shopeeClient, dispatcher }) {
    this.repository = repository;
    this.redis = redis;
    this.shopee = shopeeClient;
    this.dispatcher = dispatcher;
  }

  async getConfig() {
    const saved = await this.repository.getSetting('hunter_config', null);
    return { ...DEFAULT_HUNTER_CONFIG, ...(saved || {}) };
  }

  async saveConfig(patch = {}) {
    const cur = await this.getConfig();
    const next = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
      intervalMinutes: Math.max(10, Math.min(1440, Number(patch.intervalMinutes ?? cur.intervalMinutes) || 60)),
      minCommissionPercent: Math.max(0, Math.min(100, Number(patch.minCommissionPercent ?? cur.minCommissionPercent) || 0)),
      minPrice: Math.max(0, Number(patch.minPrice ?? cur.minPrice) || 0),
      maxPrice: Math.max(0, Number(patch.maxPrice ?? cur.maxPrice) || 0),
      minSales: Math.max(0, Number.parseInt(patch.minSales ?? cur.minSales, 10) || 0),
      maxPerRun: Math.max(1, Math.min(10, Number.parseInt(patch.maxPerRun ?? cur.maxPerRun, 10) || 3)),
      sortType: [1, 2, 3, 4, 5].includes(Number(patch.sortType ?? cur.sortType))
        ? Number(patch.sortType ?? cur.sortType)
        : 5,
      destinationJids: Array.isArray(patch.destinationJids) ? patch.destinationJids : cur.destinationJids,
      subId: typeof patch.subId === 'string' && patch.subId.trim() ? patch.subId.trim().slice(0, 64) : cur.subId,
      lastRunAt: cur.lastRunAt,
      lastRunSummary: cur.lastRunSummary,
    };
    await this.repository.setSetting('hunter_config', next);
    return next;
  }

  _matchesFilters(product, cfg, kwConfig) {
    const minCommFrac = Math.max(
      (Number(cfg.minCommissionPercent) || 0) / 100,
      Number(kwConfig.min_commission_rate) || 0
    );
    const minPrice = Math.max(Number(cfg.minPrice) || 0, Number(kwConfig.min_price) || 0);
    const maxPrice = Number(kwConfig.max_price) > 0 ? Number(kwConfig.max_price) : Number(cfg.maxPrice) || 0;
    const minSales = Math.max(Number(cfg.minSales) || 0, Number(kwConfig.min_sales) || 0);

    if (minCommFrac > 0 && (product.commissionRate === null || product.commissionRate < minCommFrac)) {
      return false;
    }
    if (minPrice > 0 && product.priceMin < minPrice) {
      return false;
    }
    if (maxPrice > 0 && product.priceMin > maxPrice) {
      return false;
    }
    if (minSales > 0 && (product.sales === null || product.sales < minSales)) {
      return false;
    }
    return true;
  }

  async runCycle({ forceManual = false } = {}) {
    const cfg = await this.getConfig();
    if (!forceManual && !cfg.enabled) {
      return { skipped: true, reason: 'hunter_disabled' };
    }

    const lockKey = 'lock:hunter_cycle';
    const lockToken = `${process.pid}-${Date.now()}`;
    if (this.redis) {
      const ok = await this.redis.setIfAbsent(lockKey, lockToken, 120);
      if (!ok) return { skipped: true, reason: 'hunter_locked' };
    }

    try {
      const allKeywords = await this.repository.listHunterKeywords();
      const activeKeywords = allKeywords.filter((k) => k.active);
      if (activeKeywords.length === 0) {
        return { skipped: true, reason: 'no_keywords', found: 0, enqueued: 0 };
      }

      const candidates = [];
      const seenItems = new Set();

      for (const kw of activeKeywords) {
        const res = await this.shopee.searchProducts({
          keyword: kw.keyword,
          page: 1,
          limit: 20,
          sortType: cfg.sortType,
          useCache: true,
        });
        for (const p of res.offers || []) {
          const itemKey = `${p.shopId}:${p.itemId}`;
          if (seenItems.has(itemKey)) continue;
          if (!this._matchesFilters(p, cfg, kw)) continue;
          seenItems.add(itemKey);
          candidates.push({ product: p, keyword: kw.keyword, score: scoreOffer(p) });
        }
      }

      candidates.sort((a, b) => b.score - a.score);

      const selected = [];
      for (const cand of candidates) {
        if (selected.length >= cfg.maxPerRun) break;
        const dedupHash = crypto
          .createHash('sha256')
          .update(`item:${cand.product.itemId}`)
          .digest('hex');

        const dup = await this.repository.hasRecentOfferByHash(dedupHash, 24);
        if (dup) continue;
        selected.push({ ...cand, dedupHash });
      }

      const destinations =
        cfg.destinationJids && cfg.destinationJids.length > 0
          ? cfg.destinationJids
          : (await this.repository.listWhatsAppGroups()).filter((g) => g.is_destination).map((g) => g.jid);

      let enqueued = 0;
      const savedOffers = [];

      for (const item of selected) {
        const p = item.product;
        let shortLink = p.offerLink || '';
        if (!shortLink) {
          const linkRes = await this.shopee.generateShortLink({
            originUrl: p.productUrl,
            subIds: cfg.subId ? [cfg.subId] : [],
          });
          shortLink = linkRes.shortLink;
        }

        const savedProd = await this.repository.upsertProduct({
          ...p,
          affiliateUrl: shortLink,
          metadata: { score: item.score, keyword: item.keyword },
        });

        const formattedMessage = formatOfferMessage({ ...p, affiliateUrl: shortLink });
        const offer = await this.repository.createOffer({
          productId: savedProd.id,
          sourceType: 'hunter',
          sourceRef: item.keyword,
          title: p.title,
          priceText: p.priceMin > 0 ? `R$ ${p.priceMin.toFixed(2)}` : '',
          commissionRate: p.commissionRate,
          originalUrl: p.productUrl,
          affiliateUrl: shortLink,
          imageUrl: p.imageUrl || '',
          formattedMessage,
          dedupHash: item.dedupHash,
        });
        savedOffers.push(offer);

        // Só enfileira disparos automáticos se o piloto estiver ativado explicitamente
        if (cfg.enabled && destinations.length > 0 && this.dispatcher) {
          for (const destJid of destinations) {
            await this.dispatcher.enqueue({
              offerId: offer.id,
              destinationJid: destJid,
              text: formattedMessage,
              imageUrl: p.imageUrl || '',
              idempotencyKey: `hunter:${offer.id}:${destJid}`,
            });
            enqueued++;
          }
        }
      }

      const summary = {
        ranAt: new Date().toISOString(),
        keywordsChecked: activeKeywords.length,
        candidatesFound: candidates.length,
        offersSelected: selected.length,
        enqueued,
      };
      await this.repository.setSetting('hunter_config', {
        ...cfg,
        lastRunAt: summary.ranAt,
        lastRunSummary: summary,
      });

      logger.info(`[CACADOR] Ciclo concluído: ${selected.length} oferta(s) salva(s), ${enqueued} envio(s) enfileirado(s).`);
      return { ...summary, offers: savedOffers };
    } finally {
      if (this.redis) {
        await this.redis.deleteIfEquals(lockKey, lockToken).catch(() => {});
      }
    }
  }
}

module.exports = { OfferHunter, DEFAULT_HUNTER_CONFIG };
