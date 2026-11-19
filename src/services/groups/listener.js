// ==============================================================================
// Listener de Mensagens WhatsApp (Espelhamento de Grupos + Privado Conversor)
// Base adaptada de gabrieldamasse-01/bot-de-automacao e ligada ao Baileys
// ==============================================================================

const crypto = require('crypto');
const logger = require('../../utils/logger');
const { extractPromoInfo } = require('../../utils/regex');
const { formatOfferMessage } = require('../shopee/formatter');

class GroupListener {
  constructor({ whatsapp, groupManager, shopeeClient, converter, dispatcher, repository, redis }) {
    this.whatsapp = whatsapp;
    this.groupManager = groupManager;
    this.shopee = shopeeClient;
    this.converter = converter;
    this.dispatcher = dispatcher;
    this.repository = repository;
    this.redis = redis;
    this._boundHandler = (msg) => {
      this.handleIncomingMessage(msg).catch((err) => {
        logger.error('[LISTENER] Erro ao processar mensagem recebida:', err.message);
      });
    };
  }

  start() {
    this.whatsapp.on('message', this._boundHandler);
    logger.info('[LISTENER] Listener de mensagens WhatsApp registrado.');
  }

  stop() {
    this.whatsapp.off('message', this._boundHandler);
  }

  _buildDedupHash(textOrUrl, itemId = '') {
    const key = itemId ? `item:${itemId}` : `text:${String(textOrUrl || '').trim().toLowerCase()}`;
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  async _isDuplicate(dedupHash, dedupHours = 12) {
    if (this.redis) {
      const redisKey = `dedup:offer:${dedupHash}`;
      const acquired = await this.redis.setIfAbsent(redisKey, '1', Math.max(60, dedupHours * 3600));
      if (!acquired) return true;
    }
    return this.repository.hasRecentOfferByHash(dedupHash, dedupHours);
  }

  async handleIncomingMessage(msg) {
    if (!msg || msg.fromMe) return;
    if (!msg.text || !msg.text.trim()) return;

    const mirrorCfg = await this.groupManager.getMirrorConfig();

    // 1) Conversor no privado do próprio número conectado (quando ativado no painel)
    if (!msg.isGroup) {
      if (!mirrorCfg.privateConverterEnabled) return;
      const promo = extractPromoInfo(msg.text);
      if (promo.shopeeUrls.length === 0) return;

      const targetUrl = promo.shopeeUrls[0];
      const converted = await this.converter.convertLink({
        url: targetUrl,
        requestedVia: 'whatsapp_private',
        requesterRef: msg.remoteJid,
      });

      if (converted.product?.imageUrl) {
        try {
          await this.whatsapp.sendImage(msg.remoteJid, converted.product.imageUrl, converted.formattedMessage);
          return;
        } catch (_) {}
      }
      await this.whatsapp.sendText(msg.remoteJid, converted.formattedMessage);
      return;
    }

    // 2) Espelhamento de grupos-fonte: NÃO encaminha sem ativação explícita
    if (!mirrorCfg.enabled) {
      return;
    }

    const groups = await this.groupManager.listGroups();
    const sourceGroup = groups.find((g) => g.jid === msg.remoteJid && g.is_source);
    if (!sourceGroup) {
      return;
    }

    const promo = extractPromoInfo(msg.text);
    if (promo.shopeeUrls.length === 0) {
      return;
    }

    const destGroups = groups.filter((g) => g.is_destination && g.jid !== msg.remoteJid);
    if (destGroups.length === 0) {
      logger.warn('[LISTENER] Nenhum grupo de destino configurado para encaminhamento.');
      return;
    }

    const rawUrl = promo.shopeeUrls[0];
    let resolved;
    try {
      resolved = await this.shopee.resolveShopeeUrl(rawUrl);
    } catch (err) {
      logger.warn(`[LISTENER] Link ignorado por validação/resolução (${err.message})`);
      return;
    }

    const dedupHash = this._buildDedupHash(resolved.canonicalUrl || rawUrl, resolved.itemId);
    if (await this._isDuplicate(dedupHash, mirrorCfg.dedupHours)) {
      logger.debug(`[LISTENER] Oferta duplicada ignorada (${resolved.itemId || rawUrl}).`);
      return;
    }

    let productDetails = null;
    if (resolved.itemId) {
      try {
        productDetails = await this.shopee.getProductOffer({
          itemId: resolved.itemId,
          shopId: resolved.shopId || null,
        });
      } catch (_) {}
    }

    const subIds = mirrorCfg.subIdOverride ? [mirrorCfg.subIdOverride] : [];
    const linkData = await this.shopee.generateShortLink({
      originUrl: resolved.canonicalUrl || resolved.resolvedUrl || rawUrl,
      subIds,
    });

    let imageBase64 = '';
    if (mirrorCfg.includeImage && msg.type === 'image' && msg.raw) {
      try {
        const imgBuf = await this.whatsapp.downloadImageBuffer(msg.raw);
        if (imgBuf) imageBase64 = imgBuf.toString('base64');
      } catch (_) {}
    }

    const title = productDetails?.title || promo.title || 'Oferta Shopee';
    const priceMin = productDetails?.priceMin || 0;
    const imageUrl = !imageBase64 && mirrorCfg.includeImage ? productDetails?.imageUrl || '' : '';
    const formattedMessage = formatOfferMessage({
      title,
      priceMin,
      priceMax: productDetails?.priceMax || 0,
      priceText: !priceMin && promo.prices.length > 0 ? promo.prices.join(' → ') : '',
      discountPercent: productDetails?.discountPercent ?? null,
      sales: productDetails?.sales ?? null,
      rating: productDetails?.rating ?? null,
      affiliateUrl: linkData.shortLink,
    });

    let savedProduct = null;
    if (productDetails) {
      savedProduct = await this.repository.upsertProduct({
        ...productDetails,
        affiliateUrl: linkData.shortLink,
      });
    }

    const savedOffer = await this.repository.createOffer({
      productId: savedProduct ? savedProduct.id : null,
      sourceType: 'group_mirror',
      sourceRef: sourceGroup.jid,
      title,
      priceText: priceMin > 0 ? `R$ ${priceMin.toFixed(2)}` : promo.prices[0] || '',
      commissionRate: productDetails?.commissionRate ?? null,
      originalUrl: rawUrl,
      affiliateUrl: linkData.shortLink,
      imageUrl,
      formattedMessage,
      dedupHash,
    });

    await this.repository.recordConversion({
      originUrl: rawUrl,
      resolvedUrl: resolved.resolvedUrl || '',
      affiliateUrl: linkData.shortLink,
      subIds: linkData.subIds,
      itemId: resolved.itemId || '',
      shopId: resolved.shopId || '',
      productTitle: title,
      priceText: savedOffer.price_text,
      commissionRate: productDetails?.commissionRate ?? null,
      imageUrl,
      requestedVia: 'mirror',
      requesterRef: sourceGroup.jid,
    });

    let enqueuedCount = 0;
    const textLower = msg.text.toLowerCase();

    for (const dest of destGroups) {
      const rules = dest.rules_json || {};
      const blockedWords = Array.isArray(rules.blockedWords) ? rules.blockedWords : [];
      if (blockedWords.some((w) => textLower.includes(String(w).toLowerCase()))) {
        continue;
      }
      if (rules.minPrice && priceMin > 0 && priceMin < Number(rules.minPrice)) {
        continue;
      }
      if (rules.maxPrice && priceMin > 0 && priceMin > Number(rules.maxPrice)) {
        continue;
      }
      const allowImg = rules.includeImage !== false && mirrorCfg.includeImage;
      await this.dispatcher.enqueue({
        offerId: savedOffer.id,
        destinationJid: dest.jid,
        text: formattedMessage,
        imageUrl: allowImg ? imageUrl : '',
        imageBase64: allowImg ? imageBase64 : '',
        idempotencyKey: `mirror:${savedOffer.id}:${dest.jid}`,
      });
      enqueuedCount++;
    }

    logger.info(`[LISTENER] Oferta de ${sourceGroup.name} enfileirada para ${enqueuedCount} grupo(s).`);
  }
}

module.exports = { GroupListener };
