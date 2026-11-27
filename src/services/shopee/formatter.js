// ==============================================================================
// Formatação de ofertas Shopee e ranqueamento de produtos
// Referência conceitual de pontuação: JVitor26/Projeto_afiliado (implementação própria)
// ==============================================================================

function formatCurrencyBrl(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '';
  return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const OPENINGS = [
  'Meninas, olha esse achadinho! 💕',
  'Olha o que encontrei para vocês! 😍',
  'Mais um achadinho da Cau! 🛍️',
  'Gente, olha essa dica! ✨',
  'Passando para compartilhar esse achadinho! 💖',
  'Olha só o que encontrei na Shopee! 🥰',
  'Trouxe mais uma dica para vocês! 💗',
];

const LINK_CALLS = [
  'Garanta o seu aqui 👇',
  'Pegue o seu aqui 👇',
  'Olha o link aqui 👇',
  'Confira esse achadinho aqui 👇',
  'Gostou? O link está aqui 👇',
  'Dá uma olhadinha aqui 👇',
];

let lastOpening = -1;
let lastLinkCall = -1;

function nextPhrase(phrases, previous) {
  if (previous < 0) return Math.floor(Math.random() * phrases.length);
  let index = Math.floor(Math.random() * (phrases.length - 1));
  if (index >= previous && previous >= 0) index += 1;
  return index;
}

function humanizeTitle(title) {
  const original = String(title || '').trim();
  if (!original) return 'Oferta Shopee';

  let cleaned = original
    .replace(/\b(?:promoção|promocao|oferta)\s+(?:imperdível|imperdivel)\b/gi, ' ')
    .replace(/\bqualidade\s+internacional\b/gi, ' ')
    .replace(/\b(?:super\s+oferta|frete\s+grátis|frete\s+gratis)\b/gi, ' ')
    .replace(/[|¦]+/g, ' - ')
    .replace(/\s*[-–—]{2,}\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:|\-–—]+|[\s,;:|\-–—]+$/g, '')
    .trim();

  if (!/[\p{L}\p{N}]/u.test(cleaned)) return original;

  if (cleaned === cleaned.toLocaleUpperCase('pt-BR') && /[\p{L}]/u.test(cleaned)) {
    const acronyms = new Set(['USB', 'LED', 'HD', 'HDMI', 'RGB', 'PVC', 'JBL', 'SSD', 'DVD', 'TV', 'LCD', 'OLED', 'PC']);
    cleaned = cleaned.replace(/[\p{L}\p{N}]+/gu, word => {
      if (acronyms.has(word) || /\d/.test(word)) return word;
      return word.toLocaleLowerCase('pt-BR');
    });
    cleaned = cleaned.replace(/\p{L}/u, letter => letter.toLocaleUpperCase('pt-BR'));
  }
  return cleaned || original;
}

function formatOfferMessage(offer = {}, { includeCommission = false } = {}) {
  let originalTitle = 'Oferta Shopee';
  let url = '';
  try {
    url = offer.affiliateUrl || offer.shortLink || offer.offerLink || offer.productUrl || '';
    originalTitle = String(offer.title || offer.productName || originalTitle).trim() || originalTitle;
    const title = humanizeTitle(originalTitle);
    const opening = nextPhrase(OPENINGS, lastOpening);
    const linkCall = url ? nextPhrase(LINK_CALLS, lastLinkCall) : -1;
    const lines = [OPENINGS[opening], '', `*${title}*`];

    const priceMin = Number(offer.priceMin || offer.price || 0);
    const priceMax = Number(offer.priceMax || 0);
    if (Number.isFinite(priceMin) && priceMin > 0) {
      lines.push('');
      if (Number.isFinite(priceMax) && priceMax > priceMin) {
        lines.push(`💰 De ${formatCurrencyBrl(priceMin)} a ${formatCurrencyBrl(priceMax)}`);
      } else {
        lines.push(`💰 Por ${formatCurrencyBrl(priceMin)}`);
      }
    } else if (offer.priceText) {
      lines.push('', `💰 ${offer.priceText}`);
    }

    const discount = Number(offer.discountPercent);
    if (offer.discountPercent != null && Number.isFinite(discount) && discount > 0 && discount <= 100) {
      lines.push(`🏷️ Desconto: ${discount.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`);
    }

    const rating = Number(offer.rating);
    if (offer.rating != null && Number.isFinite(rating) && rating > 0) {
      lines.push(`⭐ Avaliação: ${rating.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`);
    }
    const sales = Number(offer.sales);
    if (offer.sales != null && offer.sales !== '' && Number.isFinite(sales) && sales >= 0) {
      lines.push(`🛍️ ${sales.toLocaleString('pt-BR')} vendidos`);
    }
    if (includeCommission && Number(offer.commissionRate) > 0) {
      lines.push(`💸 Comissão est.: ${(Number(offer.commissionRate) * 100).toFixed(1)}%`);
    }
    if (url) lines.push('', LINK_CALLS[linkCall], String(url));

    lastOpening = opening;
    if (linkCall >= 0) lastLinkCall = linkCall;
    return lines.join('\n');
  } catch (_) {
    return [originalTitle, url ? String(url) : ''].filter(Boolean).join('\n');
  }
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
  humanizeTitle,
  scoreOffer,
};
