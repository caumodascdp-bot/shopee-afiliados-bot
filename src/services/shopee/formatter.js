// ==============================================================================
// Formatação de ofertas Shopee e ranqueamento de produtos
// Referência conceitual de pontuação: JVitor26/Projeto_afiliado (implementação própria)
// ==============================================================================

function formatCurrencyBrl(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '';
  return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatOfferMessage(offer = {}, { includeCommission = false } = {}) {
  const lines = [];
  const title = String(offer.title || offer.productName || 'Oferta Shopee').trim();
  lines.push(`🔥 *${title}*`);

  const priceMin = Number(offer.priceMin || offer.price || 0);
  const priceMax = Number(offer.priceMax || 0);
  if (priceMin > 0) {
    if (priceMax > priceMin) {
      lines.push(`💰 De ${formatCurrencyBrl(priceMin)} a ${formatCurrencyBrl(priceMax)}`);
    } else {
      lines.push(`💰 Por *${formatCurrencyBrl(priceMin)}*`);
    }
  } else if (offer.priceText) {
    lines.push(`💰 ${offer.priceText}`);
  }

  if (offer.discountPercent && Number(offer.discountPercent) > 0) {
    lines.push(`🏷️ Desconto: *${Math.round(Number(offer.discountPercent))}% OFF*`);
  }

  const meta = [];
  if (offer.rating && Number(offer.rating) > 0) {
    meta.push(`⭐ ${Number(offer.rating).toFixed(1)}`);
  }
  if (offer.sales && Number(offer.sales) > 0) {
    meta.push(`📦 ${Number(offer.sales).toLocaleString('pt-BR')} vendas`);
  }
  if (meta.length > 0) {
    lines.push(meta.join(' • '));
  }

  if (includeCommission && offer.commissionRate && Number(offer.commissionRate) > 0) {
    lines.push(`💸 Comissão est.: ${(Number(offer.commissionRate) * 100).toFixed(1)}%`);
  }

  const url = offer.affiliateUrl || offer.shortLink || offer.offerLink || offer.productUrl || '';
  if (url) {
    lines.push('');
    lines.push(`🛒 Compre aqui: ${url}`);
  }

  return lines.join('\n');
}

function scoreOffer(offer = {}) {
  let points = 0;
  const discount = Number(offer.discountPercent) || 0;
  const commissionPct = (Number(offer.commissionRate) || 0) * 100;
  const sales = Number(offer.sales) || 0;
  const rating = Number(offer.rating) || 0;

  points += Math.min(discount * 1.5, 45);
  points += Math.min(commissionPct * 3.0, 35);
  if (sales > 0) {
    points += Math.min(Math.log10(sales + 1) * 10, 30);
  }
  if (rating > 4.0) {
    points += (rating - 4.0) * 10;
  }
  return Math.round(points * 100) / 100;
}

module.exports = {
  formatCurrencyBrl,
  formatOfferMessage,
  scoreOffer,
};
