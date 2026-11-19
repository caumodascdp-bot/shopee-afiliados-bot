// ==============================================================================
// Utilitário de Regex para extração de URLs Shopee, preços e títulos
// Base adaptada de gabrieldamasse-01/bot-de-automacao
// ==============================================================================

const SHOPEE_ALLOWED_HOSTS = new Set([
  'shopee.com.br',
  'www.shopee.com.br',
  's.shopee.com.br',
  'shope.ee',
  'br.shp.ee',
]);

function extractUrls(text) {
  if (!text || typeof text !== 'string') return [];
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
  const matches = text.match(urlRegex) || [];
  // Remove pontuação final comum colada no link (.,!?:;))
  return matches.map((u) => u.replace(/[),.!?;:]+$/, ''));
}

function isShopeeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return SHOPEE_ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

function extractShopeeUrls(text) {
  return extractUrls(text).filter(isShopeeUrl);
}

function extractPrices(text) {
  if (!text || typeof text !== 'string') return [];
  const priceRegex = /R\$\s?\d{1,3}(?:\.\d{3})*(?:,\d{2})?/gi;
  return text.match(priceRegex) || [];
}

function extractPromoInfo(text) {
  if (!text || typeof text !== 'string') {
    return { urls: [], shopeeUrls: [], prices: [], title: '', rawText: '' };
  }

  const urls = extractUrls(text);
  const shopeeUrls = urls.filter(isShopeeUrl);
  const prices = extractPrices(text);

  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  let title = '';
  for (const line of lines) {
    if (!/^https?:\/\/\S+$/i.test(line)) {
      title = line.slice(0, 180);
      break;
    }
  }

  return {
    urls,
    shopeeUrls,
    prices,
    title,
    rawText: text,
  };
}

module.exports = {
  SHOPEE_ALLOWED_HOSTS,
  extractUrls,
  isShopeeUrl,
  extractShopeeUrls,
  extractPrices,
  extractPromoInfo,
};
