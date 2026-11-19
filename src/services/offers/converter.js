// ==============================================================================
// Conversor Rápido de Links Shopee (Aba 5 do Painel e Privado do WhatsApp)
// ==============================================================================

const { normalizeInputShopeeUrl } = require('../../utils/url_validator');
const { formatOfferMessage } = require('../shopee/formatter');

class OfferConverter {
  constructor({ shopeeClient, repository }) {
    this.shopee = shopeeClient;
    this.repository = repository;
  }

  async convertLink({ url, subIds = [], requestedVia = 'panel', requesterRef = '' }) {
    const cleanUrl = normalizeInputShopeeUrl(url);
    const resolved = await this.shopee.resolveShopeeUrl(cleanUrl);

    let product = null;
    if (resolved.itemId) {
      try {
        product = await this.shopee.getProductOffer({
          itemId: resolved.itemId,
          shopId: resolved.shopId || null,
        });
      } catch (_) {
        // Segue mesmo se a consulta de detalhes não retornar nó
      }
    }

    const linkResult = await this.shopee.generateShortLink({
      originUrl: resolved.canonicalUrl || resolved.resolvedUrl || cleanUrl,
      subIds,
    });

    const offerData = {
      title: product?.title || 'Oferta Shopee',
      priceMin: product?.priceMin || 0,
      priceMax: product?.priceMax || 0,
      discountPercent: product?.discountPercent ?? null,
      commissionRate: product?.commissionRate ?? null,
      sales: product?.sales ?? null,
      rating: product?.rating ?? null,
      imageUrl: product?.imageUrl || '',
      affiliateUrl: linkResult.shortLink,
      productUrl: resolved.canonicalUrl || resolved.resolvedUrl,
    };

    const formattedMessage = formatOfferMessage(offerData);

    await this.repository.recordConversion({
      originUrl: cleanUrl,
      resolvedUrl: resolved.resolvedUrl,
      affiliateUrl: linkResult.shortLink,
      subIds: linkResult.subIds,
      itemId: resolved.itemId || '',
      shopId: resolved.shopId || '',
      productTitle: offerData.title,
      priceText: offerData.priceMin > 0 ? `R$ ${offerData.priceMin.toFixed(2)}` : '',
      commissionRate: offerData.commissionRate,
      imageUrl: offerData.imageUrl,
      requestedVia,
      requesterRef,
    });

    return {
      originUrl: cleanUrl,
      resolvedUrl: resolved.resolvedUrl,
      itemId: resolved.itemId || '',
      shopId: resolved.shopId || '',
      shortLink: linkResult.shortLink,
      subIds: linkResult.subIds,
      product: offerData,
      formattedMessage,
    };
  }
}

module.exports = { OfferConverter };
