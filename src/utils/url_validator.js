// ==============================================================================
// Validação de URLs com proteção contra SSRF (Allowlist HTTPS estrita)
// Inspirado nos contratos verificados de jeffmonteiroo/shopee-br-affiliate-mcp (MIT)
// ==============================================================================

const net = require('net');

const SHOPEE_PRODUCT_HOSTS = new Set(['shopee.com.br', 'www.shopee.com.br']);
const SHOPEE_RESOLVE_HOSTS = new Set([
  'shopee.com.br',
  'www.shopee.com.br',
  's.shopee.com.br',
  'shope.ee',
  'br.shp.ee',
]);
const SHOPEE_AFFILIATE_HOSTS = new Set(['s.shopee.com.br', 'shope.ee', 'shopee.com.br', 'www.shopee.com.br']);
const SHOPEE_IMAGE_HOST_SUFFIXES = ['.susercontent.com', '.shopee.com.br'];
const SHOPEE_IMAGE_EXACT_HOSTS = new Set(['down-br.img.susercontent.com', 'cf.shopee.com.br']);

function isBlockedIpLiteral(hostname) {
  const clean = hostname.replace(/^\[|\]$/g, '');
  const ipVer = net.isIP(clean);
  if (!ipVer) return false;
  if (clean === '127.0.0.1' || clean === '::1' || clean === '0.0.0.0') return true;
  if (clean.startsWith('10.') || clean.startsWith('192.168.') || clean.startsWith('169.254.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(clean)) return true;
  if (clean.toLowerCase().startsWith('fe80:') || clean.toLowerCase().startsWith('fc') || clean.toLowerCase().startsWith('fd')) {
    return true;
  }
  return false;
}

function validateAllowedHttpsUrl(rawUrl, allowedHosts, { allowSuffixes = [] } = {}) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048) {
    throw new Error('URL inválida ou acima do tamanho permitido.');
  }
  if (/[\x00-\x20\x7f]/.test(rawUrl)) {
    throw new Error('URL contém caracteres inválidos.');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    throw new Error('Formato de URL inválido.');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Somente URLs HTTPS são permitidas.');
  }
  if (parsed.port && parsed.port !== '443') {
    throw new Error('Porta explícita não permitida na URL.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Credenciais embutidas na URL são proibidas.');
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || isBlockedIpLiteral(host)) {
    throw new Error('Endereço local ou IP privado bloqueado por proteção SSRF.');
  }

  const exactMatch = allowedHosts && allowedHosts.has(host);
  const suffixMatch = allowSuffixes.some((sfx) => host.endsWith(sfx) && host.length > sfx.length);
  if (!exactMatch && !suffixMatch) {
    throw new Error(`Domínio não permitido por proteção SSRF: ${host}`);
  }

  return parsed.toString();
}

function normalizeInputShopeeUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    throw new Error('Informe um link da Shopee válido.');
  }
  let candidate = rawUrl.trim();
  if (candidate.startsWith('http://')) {
    candidate = `https://${candidate.slice('http://'.length)}`;
  }
  return validateAllowedHttpsUrl(candidate, SHOPEE_RESOLVE_HOSTS);
}

function validateShopeeImageUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    return validateAllowedHttpsUrl(rawUrl.trim(), SHOPEE_IMAGE_EXACT_HOSTS, {
      allowSuffixes: SHOPEE_IMAGE_HOST_SUFFIXES,
    });
  } catch (_) {
    return null;
  }
}

module.exports = {
  SHOPEE_PRODUCT_HOSTS,
  SHOPEE_RESOLVE_HOSTS,
  SHOPEE_AFFILIATE_HOSTS,
  validateAllowedHttpsUrl,
  normalizeInputShopeeUrl,
  validateShopeeImageUrl,
  isBlockedIpLiteral,
};
