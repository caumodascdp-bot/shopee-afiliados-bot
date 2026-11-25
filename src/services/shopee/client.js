// ==============================================================================
// Cliente Oficial da Open API de Afiliados Shopee Brasil (GraphQL)
// Contratos oficiais verificados com base em jeffmonteiroo/shopee-br-affiliate-mcp (MIT)
// Endpoint: https://open-api.affiliate.shopee.com.br/graphql
// ==============================================================================

const crypto = require('crypto');
const logger = require('../../utils/logger');
const { sleep } = require('../../utils/delay');
const {
  SHOPEE_PRODUCT_HOSTS,
  SHOPEE_RESOLVE_HOSTS,
  SHOPEE_AFFILIATE_HOSTS,
  validateAllowedHttpsUrl,
  normalizeInputShopeeUrl,
  validateShopeeImageUrl,
} = require('../../utils/url_validator');

const OFFICIAL_ENDPOINT = 'https://open-api.affiliate.shopee.com.br/graphql';
const HOURLY_BUDGET = 8000;
const MIN_GAP_MS = 500;
const SUB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const SHOPEE_ERROR_CODES = {
  '10000': 'Erro interno no servidor da Shopee. Tente novamente em instantes.',
  '10010': 'A API Shopee recusou os parâmetros ou o formato da consulta GraphQL.',
  '10020': 'Assinatura ou credenciais Shopee inválidas (verifique App ID, Secret Key e relógio do servidor).',
  '10030': 'Limite de requisições da API Shopee atingido. Aguarde antes de consultar novamente.',
  '10031': 'Acesso negado pela API Shopee.',
  '10032': 'Identificador de afiliado inválido ou recusado pela Shopee.',
  '10033': 'Conta de afiliado Shopee congelada.',
  '10034': 'Conta de afiliado Shopee bloqueada.',
  '10035': 'Conta ainda não possui permissão liberada para a Open API no painel da Shopee.',
  '11000': 'Operação recusada por regra de negócio da Shopee.',
  '11001': 'Parâmetros inválidos na operação Shopee.',
  '11002': 'Erro de vinculação da conta de afiliado na Shopee.',
};

class ShopeeApiError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'ShopeeApiError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function buildShopeeSignature({ appId, secretKey, timestamp, payloadString }) {
  if (!appId || !secretKey) {
    throw new ShopeeApiError('CREDENTIALS_MISSING', 'Configure o App ID e a Secret Key da Shopee antes de consultar.', 400);
  }
  const ts = String(timestamp);
  const factor = `${appId}${ts}${payloadString}${secretKey}`;
  const signature = crypto.createHash('sha256').update(factor, 'utf8').digest('hex');
  return {
    signature,
    authorization: `SHA256 Credential=${appId}, Timestamp=${ts}, Signature=${signature}`,
  };
}

function validateSubIds(subIds = []) {
  const list = Array.isArray(subIds) ? subIds.map((s) => String(s || '').trim()).filter(Boolean) : [];
  if (list.length > 5) {
    throw new ShopeeApiError('INVALID_SUB_IDS', 'A Shopee permite no máximo 5 Sub IDs por link.', 400);
  }
  for (const sub of list) {
    if (!SUB_ID_PATTERN.test(sub)) {
      throw new ShopeeApiError(
        'INVALID_SUB_IDS',
        'Cada Sub ID deve conter apenas letras, números, "_" ou "-" (até 64 caracteres).',
        400
      );
    }
  }
  return list;
}

function parseProductIdsFromUrl(rawUrl) {
  const validated = validateAllowedHttpsUrl(rawUrl, SHOPEE_PRODUCT_HOSTS);
  const u = new URL(validated);
  let match = u.pathname.match(/^\/product\/(\d+)\/(\d+)(?:\/|$)/);
  if (!match) {
    match = u.pathname.match(/-i\.(\d+)\.(\d+)(?:\/|$)/);
  }
  let shopId = '';
  let itemId = '';
  if (match) {
    shopId = match[1];
    itemId = match[2];
  } else {
    const qShop = u.searchParams.get('shopid') || '';
    const qItem = u.searchParams.get('itemid') || '';
    if (/^\d{1,20}$/.test(qShop) && /^\d{1,20}$/.test(qItem)) {
      shopId = qShop;
      itemId = qItem;
    }
  }
  if (!shopId || !itemId) {
    return null;
  }
  return {
    shopId,
    itemId,
    canonicalUrl: `https://shopee.com.br/product/${shopId}/${itemId}`,
  };
}

function normalizeOfferNode(node) {
  if (!node || typeof node !== 'object') return null;
  const itemId = String(node.itemId || '').trim();
  const shopId = String(node.shopId || '').trim();
  const productName = String(node.productName || '').trim();
  if (!itemId || !productName) return null;

  const priceMin = Number.parseFloat(node.priceMin ?? node.price ?? 0) || 0;
  const priceMax = Number.parseFloat(node.priceMax ?? node.price ?? priceMin) || priceMin;
  const discountPercent = node.priceDiscountRate != null ? Number.parseFloat(node.priceDiscountRate) : null;
  const commissionRate = node.commissionRate != null ? Number.parseFloat(node.commissionRate) : null;
  const sellerCommissionRate = node.sellerCommissionRate != null ? Number.parseFloat(node.sellerCommissionRate) : null;
  const shopeeCommissionRate = node.shopeeCommissionRate != null ? Number.parseFloat(node.shopeeCommissionRate) : null;
  const commissionEstimated = node.commission != null ? Number.parseFloat(node.commission) : null;
  const sales = node.sales != null ? Number.parseInt(node.sales, 10) : null;
  const rating = node.ratingStar != null ? Number.parseFloat(node.ratingStar) : null;

  const productUrl = node.productLink || (shopId ? `https://shopee.com.br/product/${shopId}/${itemId}` : '');
  const offerLink = node.offerLink || '';
  const imageUrl = validateShopeeImageUrl(node.imageUrl || '') || '';

  return {
    itemId,
    shopId,
    title: productName.slice(0, 500),
    shopName: String(node.shopName || '').slice(0, 200),
    priceMin,
    priceMax,
    discountPercent: Number.isFinite(discountPercent) ? discountPercent : null,
    commissionRate: Number.isFinite(commissionRate) ? commissionRate : null,
    sellerCommissionRate: Number.isFinite(sellerCommissionRate) ? sellerCommissionRate : null,
    shopeeCommissionRate: Number.isFinite(shopeeCommissionRate) ? shopeeCommissionRate : null,
    commissionEstimated: Number.isFinite(commissionEstimated) ? commissionEstimated : null,
    sales: Number.isFinite(sales) ? sales : null,
    rating: Number.isFinite(rating) ? rating : null,
    productUrl,
    offerLink,
    imageUrl,
    categoryIds: Array.isArray(node.productCatIds) ? node.productCatIds : [],
    shopTypes: Array.isArray(node.shopType) ? node.shopType : node.shopType ? [node.shopType] : [],
    periodStartTime: node.periodStartTime || null,
    periodEndTime: node.periodEndTime || null,
  };
}

class ShopeeClient {
  constructor({
    repository,
    redis,
    cryptoHelper,
    encryptionKey = '',
    endpoint = OFFICIAL_ENDPOINT,
    fetchImpl = globalThis.fetch,
    clock = () => Math.floor(Date.now() / 1000),
    defaultCredentials = {},
    isProduction = false,
  } = {}) {
    this.repository = repository;
    this.redis = redis;
    this.crypto = cryptoHelper;
    this.encryptionKey = encryptionKey;
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.defaultCredentials = defaultCredentials;
    this.isProduction = isProduction;
    this._callTimestamps = [];
    this._lastCallMs = 0;
    this._queueLock = Promise.resolve();
  }

  async getCredentials() {
    let stored = null;
    if (this.repository) {
      stored = await this.repository.getShopeeCredentials();
    }
    const appId = (stored && stored.app_id) || this.defaultCredentials.appId || '';
    let secretKey = this.defaultCredentials.secretKey || '';

    if (stored && stored.secret_key_encrypted) {
      try {
        const dec = this.crypto.decryptJson(stored.secret_key_encrypted, this.encryptionKey, 'shopee:secret', {
          isProduction: this.isProduction,
        });
        if (dec && dec.secretKey) {
          secretKey = dec.secretKey;
        }
      } catch (err) {
        logger.warn('[SHOPEE] Falha ao descriptografar Secret Key armazenada:', err.message);
      }
    }

    const defaultSubId = (stored && stored.default_sub_id) || this.defaultCredentials.defaultSubId || 'whatsapp_grupos';
    return {
      appId: String(appId).trim(),
      secretKey: String(secretKey).trim(),
      defaultSubId: String(defaultSubId).trim(),
      hasSecretKey: Boolean(secretKey),
      lastTestedAt: stored ? stored.last_tested_at : null,
      lastTestStatus: stored ? stored.last_test_status : 'untested',
      lastTestError: stored ? stored.last_test_error : '',
    };
  }

  async saveCredentials({ appId, secretKey, defaultSubId }) {
    const cleanAppId = String(appId || '').trim();
    if (!cleanAppId || !/^[A-Za-z0-9_-]{1,128}$/.test(cleanAppId)) {
      throw new ShopeeApiError('INVALID_APP_ID', 'App ID inválido. Use apenas letras, números, "_" ou "-".', 400);
    }

    const cleanSubId = String(defaultSubId || 'whatsapp_grupos').trim();
    validateSubIds(cleanSubId ? [cleanSubId] : []);

    let secretKeyEncrypted = '';
    if (secretKey && String(secretKey).trim()) {
      secretKeyEncrypted = this.crypto.encryptJson(
        { secretKey: String(secretKey).trim() },
        this.encryptionKey,
        'shopee:secret',
        { isProduction: this.isProduction }
      );
    }

    const saved = await this.repository.saveShopeeCredentials({
      appId: cleanAppId,
      secretKeyEncrypted,
      defaultSubId: cleanSubId,
      subIds: cleanSubId ? [cleanSubId] : [],
    });

    return {
      appId: saved.app_id,
      hasSecretKey: Boolean(saved.secret_key_encrypted || this.defaultCredentials.secretKey),
      secretKeyMasked: secretKey ? this.crypto.maskSecret(secretKey) : '',
      defaultSubId: saved.default_sub_id,
    };
  }

  async _withRateLimit(taskFn) {
    const run = async () => {
      const now = Date.now();
      while (this._callTimestamps.length > 0 && now - this._callTimestamps[0] >= 3600 * 1000) {
        this._callTimestamps.shift();
      }
      if (this._callTimestamps.length >= HOURLY_BUDGET) {
        throw new ShopeeApiError('LOCAL_RATE_LIMIT', 'Orçamento local de 8.000 chamadas/hora da Shopee atingido.', 429);
      }
      const waitMs = MIN_GAP_MS - (now - this._lastCallMs);
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      this._lastCallMs = Date.now();
      this._callTimestamps.push(this._lastCallMs);
      return taskFn();
    };

    const next = this._queueLock.then(run, run);
    this._queueLock = next.catch(() => {});
    return next;
  }

  async _graphqlRequest({ operationName, query, variables = {}, isMutation = false }) {
    const creds = await this.getCredentials();
    if (!creds.appId || !creds.secretKey) {
      throw new ShopeeApiError(
        'CREDENTIALS_MISSING',
        'Credenciais da Shopee não configuradas. Preencha App ID e Secret Key na aba Shopee.',
        400
      );
    }

    const payloadObj = { query, variables };
    if (operationName) payloadObj.operationName = operationName;
    const payloadString = JSON.stringify(payloadObj);
    const maxAttempts = isMutation ? 1 : 2;

    return this._withRateLimit(async () => {
      let lastErr;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const timestamp = this.clock();
        const { authorization } = buildShopeeSignature({
          appId: creds.appId,
          secretKey: creds.secretKey,
          timestamp,
          payloadString,
        });

        try {
          const response = await this.fetchImpl(this.endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              Authorization: authorization,
              'User-Agent': 'ShopeeAfiliadosBot/1.0',
            },
            body: payloadString,
            redirect: 'error',
            signal: AbortSignal.timeout(15000),
          });

          if (response.status === 401 || response.status === 403) {
            throw new ShopeeApiError('UPSTREAM_AUTH', 'A API Shopee recusou a autenticação (HTTP 401/403).', 401);
          }
          if (response.status === 429) {
            throw new ShopeeApiError('UPSTREAM_RATE_LIMIT', 'Limite de tráfego da API Shopee atingido (HTTP 429).', 429);
          }
          if (response.status >= 500 && attempt < maxAttempts) {
            await sleep(500 * attempt);
            continue;
          }
          if (!response.ok) {
            throw new ShopeeApiError('UPSTREAM_HTTP', `Resposta inesperada da API Shopee (HTTP ${response.status}).`, 502);
          }

          const json = await response.json();
          if (json && Array.isArray(json.errors) && json.errors.length > 0) {
            const firstErr = json.errors[0] || {};
            const code = String(firstErr?.extensions?.code || firstErr?.code || '').trim();
            if (code === '10000' && attempt < maxAttempts) {
              await sleep(500 * attempt);
              continue;
            }
            const friendly = SHOPEE_ERROR_CODES[code] || `Erro oficial GraphQL da Shopee${code ? ` (${code})` : ''}.`;
            throw new ShopeeApiError(code || 'UPSTREAM_GRAPHQL', friendly, 400);
          }

          if (!json || !json.data) {
            throw new ShopeeApiError('UPSTREAM_SHAPE', 'Resposta da API Shopee sem bloco data.', 502);
          }
          return json.data;
        } catch (err) {
          lastErr = err;
          if (err instanceof ShopeeApiError) {
            throw err;
          }
          if (attempt < maxAttempts) {
            await sleep(500 * attempt);
            continue;
          }
        }
      }
      throw new ShopeeApiError(
        isMutation ? 'LINK_OUTCOME_UNKNOWN' : 'UPSTREAM_NETWORK',
        `Falha de comunicação com a API Shopee: ${lastErr ? lastErr.message : 'erro desconhecido'}`,
        504
      );
    });
  }

  async resolveShopeeUrl(rawUrl) {
    let currentUrl = normalizeInputShopeeUrl(rawUrl);
    const parsedDirect = (() => {
      try {
        return parseProductIdsFromUrl(currentUrl);
      } catch (_) {
        return null;
      }
    })();
    if (parsedDirect) {
      return {
        originUrl: rawUrl,
        resolvedUrl: currentUrl,
        ...parsedDirect,
      };
    }

    const cacheKey = `shopee:url:${crypto.createHash('sha1').update(currentUrl).digest('hex')}`;
    if (this.redis) {
      const cached = await this.redis.getJson(cacheKey);
      if (cached) return cached;
    }

    for (let hop = 0; hop < 6; hop++) {
      validateAllowedHttpsUrl(currentUrl, SHOPEE_RESOLVE_HOSTS);
      const response = await this.fetchImpl(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': 'ShopeeAfiliadosBot/1.0' },
        signal: AbortSignal.timeout(8000),
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) break;
        const nextUrl = new URL(location, currentUrl).toString();
        currentUrl = validateAllowedHttpsUrl(nextUrl, SHOPEE_RESOLVE_HOSTS);
        const ids = (() => {
          try {
            return parseProductIdsFromUrl(currentUrl);
          } catch (_) {
            return null;
          }
        })();
        if (ids) {
          const result = { originUrl: rawUrl, resolvedUrl: currentUrl, ...ids };
          if (this.redis) await this.redis.setJson(cacheKey, result, 1800);
          return result;
        }
        continue;
      }
      break;
    }

    let ids = null;
    try {
      ids = parseProductIdsFromUrl(currentUrl);
    } catch (_) {
      ids = null;
    }

    const fallback = {
      originUrl: rawUrl,
      resolvedUrl: currentUrl,
      shopId: ids ? ids.shopId : '',
      itemId: ids ? ids.itemId : '',
      canonicalUrl: ids ? ids.canonicalUrl : currentUrl,
    };
    if (this.redis) await this.redis.setJson(cacheKey, fallback, 900);
    return fallback;
  }

  async searchProducts({
    keyword = '',
    page = 1,
    limit = 20,
    sortType = 5,
    listType = 0,
    shopId = null,
    categoryId = null,
    isAmsOffer = null,
    isKeySeller = null,
    useCache = true,
  } = {}) {
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
    const safePage = Math.max(1, Number(page) || 1);
    const safeSort = [1, 2, 3, 4, 5].includes(Number(sortType)) ? Number(sortType) : 5;
    const safeListType = Number.isInteger(Number(listType)) ? Number(listType) : 0;

    const cacheKey = `shopee:search:${crypto
      .createHash('sha1')
      .update(JSON.stringify({ keyword, safePage, safeLimit, safeSort, safeListType, shopId, categoryId, isAmsOffer, isKeySeller }))
      .digest('hex')}`;

    if (useCache && this.redis) {
      const cached = await this.redis.getJson(cacheKey);
      if (cached) return cached;
    }

    const query = `query SearchProductOffers(
      $keyword: String
      $page: Int
      $limit: Int
      $sortType: Int
      $listType: Int
      $shopId: Int64
      $productCatId: Int
      $isAMSOffer: Boolean
      $isKeySeller: Boolean
    ) {
      productOfferV2(
        keyword: $keyword
        page: $page
        limit: $limit
        sortType: $sortType
        listType: $listType
        shopId: $shopId
        productCatId: $productCatId
        isAMSOffer: $isAMSOffer
        isKeySeller: $isKeySeller
      ) {
        nodes {
          itemId
          shopId
          productName
          shopName
          productLink
          offerLink
          priceMin
          priceMax
          commissionRate
          commission
          sales
          ratingStar
          periodStartTime
          periodEndTime
          imageUrl
          productCatIds
          priceDiscountRate
          shopType
          sellerCommissionRate
          shopeeCommissionRate
        }
        pageInfo {
          page
          limit
          hasNextPage
        }
      }
    }`;

    const variables = {
      keyword: String(keyword || ''),
      page: safePage,
      limit: safeLimit,
      sortType: safeSort,
      listType: safeListType,
    };
    if (shopId) variables.shopId = Number(shopId);
    if (categoryId) variables.productCatId = Number(categoryId);
    if (typeof isAmsOffer === 'boolean') variables.isAMSOffer = isAmsOffer;
    if (typeof isKeySeller === 'boolean') variables.isKeySeller = isKeySeller;

    const data = await this._graphqlRequest({
      operationName: 'SearchProductOffers',
      query,
      variables,
    });

    const block = data.productOfferV2 || {};
    const nodes = Array.isArray(block.nodes) ? block.nodes : [];
    const offers = nodes.map(normalizeOfferNode).filter(Boolean);
    const result = {
      offers,
      pageInfo: block.pageInfo || { page: safePage, limit: safeLimit, hasNextPage: false },
    };

    if (useCache && this.redis) {
      await this.redis.setJson(cacheKey, result, 300);
    }
    return result;
  }

  async getProductOffer({ itemId, shopId = null }) {
    if (!/^\d{1,20}$/.test(String(itemId || ''))) {
      throw new ShopeeApiError('INVALID_ITEM_ID', 'itemId inválido para consulta na Shopee.', 400);
    }

    const cacheKey = `shopee:product:${shopId || 'any'}:${itemId}`;
    if (this.redis) {
      const cached = await this.redis.getJson(cacheKey);
      if (cached) return cached;
    }

    const query = `query GetProductOffer($itemId: Int64, $shopId: Int64) {
      productOfferV2(itemId: $itemId, shopId: $shopId) {
        nodes {
          itemId
          shopId
          productName
          shopName
          productLink
          offerLink
          priceMin
          priceMax
          commissionRate
          commission
          sales
          ratingStar
          periodStartTime
          periodEndTime
          imageUrl
          productCatIds
          priceDiscountRate
          shopType
          sellerCommissionRate
          shopeeCommissionRate
        }
      }
    }`;

    const variables = { itemId: Number(itemId) };
    if (shopId && /^\d{1,20}$/.test(String(shopId))) {
      variables.shopId = Number(shopId);
    }

    const data = await this._graphqlRequest({
      operationName: 'GetProductOffer',
      query,
      variables,
    });

    const nodes = (data.productOfferV2 && data.productOfferV2.nodes) || [];
    const offer = nodes.length > 0 ? normalizeOfferNode(nodes[0]) : null;
    if (offer && this.redis) {
      await this.redis.setJson(cacheKey, offer, 600);
    }
    return offer;
  }

  async generateShortLink({ originUrl, subIds = [] }) {
    const cleanOrigin = validateAllowedHttpsUrl(normalizeInputShopeeUrl(originUrl), SHOPEE_RESOLVE_HOSTS);
    const creds = await this.getCredentials();
    const chosenSubIds = subIds && subIds.length > 0 ? subIds : creds.defaultSubId ? [creds.defaultSubId] : [];
    const validatedSubIds = validateSubIds(chosenSubIds);

    const mutation = `mutation GenerateShortLink($input: ShortLinkInput!) {
      generateShortLink(input: $input) {
        shortLink
      }
    }`;

    const data = await this._graphqlRequest({
      operationName: 'GenerateShortLink',
      query: mutation,
      variables: {
        input: {
          originUrl: cleanOrigin,
          subIds: validatedSubIds,
        },
      },
      isMutation: true,
    });

    const shortLink = data?.generateShortLink?.shortLink || '';
    if (!shortLink) {
      throw new ShopeeApiError('UPSTREAM_SHAPE', 'A API Shopee não retornou shortLink.', 502);
    }
    validateAllowedHttpsUrl(shortLink, SHOPEE_AFFILIATE_HOSTS);
    return {
      originUrl: cleanOrigin,
      shortLink,
      subIds: validatedSubIds,
    };
  }

  async testConnection() {
    try {
      const result = await this.searchProducts({
        keyword: 'celular',
        page: 1,
        limit: 1,
        sortType: 2,
        useCache: false,
      });
      await this.repository?.updateShopeeTestStatus({ status: 'ok', error: '' });
      return {
        ok: true,
        sampleCount: result.offers.length,
        sampleTitle: result.offers[0]?.title || null,
      };
    } catch (err) {
      await this.repository?.updateShopeeTestStatus({ status: 'error', error: err.message });
      return {
        ok: false,
        code: err.code || 'SHOPEE_TEST_ERROR',
        error: err.message,
      };
    }
  }
}

module.exports = {
  ShopeeClient,
  ShopeeApiError,
  OFFICIAL_ENDPOINT,
  SHOPEE_ERROR_CODES,
  buildShopeeSignature,
  validateSubIds,
  parseProductIdsFromUrl,
  normalizeOfferNode,
};
