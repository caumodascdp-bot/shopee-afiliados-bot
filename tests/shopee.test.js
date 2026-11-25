const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const cryptoHelper = require('../src/utils/crypto');
const { Repository } = require('../src/database/repository');
const { RedisClient } = require('../src/redis/client');
const {
  ShopeeClient,
  buildShopeeSignature,
  validateSubIds,
  parseProductIdsFromUrl,
} = require('../src/services/shopee/client');
const { normalizeInputShopeeUrl } = require('../src/utils/url_validator');

test('Shopee: gera assinatura SHA-256 exata conforme contrato oficial BR', () => {
  const appId = '183990001';
  const secretKey = 'segredo_super_secreto';
  const timestamp = 1790000123;
  const payloadString = '{"query":"{ productOfferV2 { nodes { itemId } } }","variables":{}}';

  const expectedDigest = crypto
    .createHash('sha256')
    .update(`${appId}${timestamp}${payloadString}${secretKey}`, 'utf8')
    .digest('hex');

  const res = buildShopeeSignature({ appId, secretKey, timestamp, payloadString });
  assert.equal(res.signature, expectedDigest);
  assert.equal(
    res.authorization,
    `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${expectedDigest}`
  );
});

test('Shopee: valida até 5 Sub IDs e rejeita caracteres inválidos', () => {
  assert.deepEqual(validateSubIds(['grupo_vip', 'promo-01']), ['grupo_vip', 'promo-01']);
  assert.throws(() => validateSubIds(['a', 'b', 'c', 'd', 'e', 'f']), /no máximo 5 Sub IDs/);
  assert.throws(() => validateSubIds(['sub id invalido!']), /letras, números/);
});

test('Shopee: parseProductIdsFromUrl e proteção SSRF bloqueiam domínios externos e IPs privados', () => {
  const parsed = parseProductIdsFromUrl('https://shopee.com.br/Fone-Bluetooth-i.123456.987654321');
  assert.equal(parsed.shopId, '123456');
  assert.equal(parsed.itemId, '987654321');
  assert.equal(parsed.canonicalUrl, 'https://shopee.com.br/product/123456/987654321');

  assert.throws(() => normalizeInputShopeeUrl('https://127.0.0.1/shopee'), /SSRF|bloqueado/i);
  assert.throws(() => normalizeInputShopeeUrl('https://169.254.169.254/latest/meta-data'), /SSRF|bloqueado/i);
  assert.throws(() => normalizeInputShopeeUrl('https://evil.example.com/shopee'), /Domínio não permitido/i);
});

test('Shopee: searchProducts e generateShortLink enviam assinatura válida, ocultam secret e tratam erro 10035', async () => {
  const repository = new Repository();
  const redis = new RedisClient({ isTest: true });
  const encKey = 'chave-teste-32-caracteres-segura!';

  const calls = [];
  const fetchMock = async (url, opts) => {
    calls.push({ url, opts });
    const parsedBody = JSON.parse(opts.body);
    if (parsedBody.operationName === 'SearchProductOffers') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            productOfferV2: {
              nodes: [
                {
                  itemId: '998877',
                  shopId: '112233',
                  productName: 'Air Fryer Digital 5L',
                  shopName: 'Loja Oficial',
                  productLink: 'https://shopee.com.br/product/112233/998877',
                  offerLink: 'https://shope.ee/xyz123',
                  priceMin: '299.90',
                  priceMax: '299.90',
                  priceDiscountRate: '25',
                  commissionRate: '0.10',
                  commission: '29.99',
                  sales: 450,
                  ratingStar: '4.9',
                  imageUrl: 'https://down-br.img.susercontent.com/file/foto.jpg',
                },
              ],
              pageInfo: { page: 1, limit: 20, hasNextPage: false },
            },
          },
        }),
      };
    }
    if (parsedBody.operationName === 'GenerateShortLink') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { generateShortLink: { shortLink: 'https://shope.ee/curto999' } },
        }),
      };
    }
    return { ok: false, status: 500 };
  };

  const client = new ShopeeClient({
    repository,
    redis,
    cryptoHelper,
    encryptionKey: encKey,
    fetchImpl: fetchMock,
    clock: () => 1790000500,
  });

  const saved = await client.saveCredentials({
    appId: 'app_teste_01',
    secretKey: 'super_secret_shopee_key',
    defaultSubId: 'canal_vip',
  });
  assert.equal(saved.appId, 'app_teste_01');
  assert.equal(saved.hasSecretKey, true);
  assert.ok(!JSON.stringify(saved).includes('super_secret_shopee_key'));

  const searchRes = await client.searchProducts({ keyword: 'air fryer', limit: 20 });
  assert.equal(searchRes.offers.length, 1);
  assert.equal(searchRes.offers[0].itemId, '998877');
  assert.ok(calls[0].opts.headers.Authorization.startsWith('SHA256 Credential=app_teste_01, Timestamp=1790000500, Signature='));

  const linkRes = await client.generateShortLink({
    originUrl: 'https://shopee.com.br/product/112233/998877',
    subIds: ['stories'],
  });
  assert.equal(linkRes.shortLink, 'https://shope.ee/curto999');

  // Testa erro oficial 10035 (conta sem acesso à Open API)
  client.fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ errors: [{ message: 'no access', extensions: { code: 10035 } }] }),
  });
  const testErr = await client.testConnection();
  assert.equal(testErr.ok, false);
  assert.equal(testErr.code, '10035');
  assert.match(testErr.error, /Open API/);
});

test('Shopee: tenta novamente erro temporário 10000 em consulta, sem repetir mutação', async () => {
  let calls = 0;
  const client = new ShopeeClient({
    defaultCredentials: { appId: 'app', secretKey: 'secret' },
    fetchImpl: async () => {
      calls++;
      return { ok: true, status: 200, json: async () => calls === 1
        ? { errors: [{ extensions: { code: 10000 } }] }
        : { data: { productOfferV2: { nodes: [] } } } };
    },
  });
  const result = await client.searchProducts({ useCache: false });
  assert.equal(result.offers.length, 0);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(client.generateShortLink({ originUrl: 'https://shopee.com.br/product/1/2' }), { code: '10000' });
  assert.equal(calls, 1);
});
