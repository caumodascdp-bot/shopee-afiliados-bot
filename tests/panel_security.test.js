const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const { createRuntime } = require('../index');

async function callApi(baseUrl, path, { method = 'GET', body = null, headers = {}, cookie = '' } = {}) {
  const reqHeaders = { 'X-Requested-With': 'XMLHttpRequest', ...headers };
  if (cookie) reqHeaders.Cookie = cookie;
  if (body !== null) reqHeaders['Content-Type'] = 'application/json';
  const resp = await fetch(`${baseUrl}${path}`, {
    method,
    headers: reqHeaders,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const setCookie = resp.headers.get('set-cookie') || '';
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {}
  return { status: resp.status, json, text, setCookie };
}

test('Painel e Segurança: /api/ping rápido, troca obrigatória de senha, CSRF, rate limit e 5 abas sem vazar segredos', async () => {
  const pingSecret = crypto.randomBytes(16).toString('hex');
  const encKey = crypto.randomBytes(24).toString('hex');

  const runtime = await createRuntime({
    port: 0,
    isTest: true,
    isProduction: false,
    pingSecret,
    sessionEncryptionKey: encKey,
    authCookieSecret: encKey,
    adminPasswordHash: '',
    rateLimitOptions: { loginMax: 3, apiMax: 200 },
  });

  // Mock Shopee para teste de API no painel
  runtime.shopeeClient.fetchImpl = async (_url, opts) => {
    const b = JSON.parse(opts.body || '{}');
    if (b.operationName === 'GenerateShortLink') {
      return { ok: true, status: 200, json: async () => ({ data: { generateShortLink: { shortLink: 'https://shope.ee/painel1' } } }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          productOfferV2: {
            nodes: [
              {
                itemId: '777',
                shopId: '888',
                productName: 'Produto Painel',
                productLink: 'https://shopee.com.br/product/888/777',
                priceMin: '50.00',
                priceMax: '50.00',
                commissionRate: '0.1',
                sales: 100,
                imageUrl: 'https://down-br.img.susercontent.com/file/p.jpg',
              },
            ],
            pageInfo: { page: 1, limit: 1, hasNextPage: false },
          },
        },
      }),
    };
  };

  const server = http.createServer(runtime.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // /api/ping sem e com PING_SECRET
    assert.equal((await callApi(baseUrl, '/api/ping')).status, 401);
    const pingOk = await callApi(baseUrl, '/api/ping', { headers: { 'x-ping-secret': pingSecret } });
    assert.equal(pingOk.status, 200);
    assert.equal(pingOk.json.ok, true);

    // HTML contém as 5 abas
    const html = await callApi(baseUrl, '/');
    assert.equal(html.status, 200);
    assert.match(html.text, /1\. WhatsApp/);
    assert.match(html.text, /2\. Shopee/);
    assert.match(html.text, /3\. Grupos/);
    assert.match(html.text, /4\. Caçador/);
    assert.match(html.text, /5\. Conversor/);

    // Sem login -> 401
    assert.equal((await callApi(baseUrl, '/api/shopee/config')).status, 401);

    // Rate limit no login (3 tentativas erradas -> 4ª retorna 429)
    for (let i = 0; i < 3; i++) {
      const bad = await callApi(baseUrl, '/api/auth/login', {
        method: 'POST',
        body: { username: 'admin', password: 'errada' },
      });
      assert.equal(bad.status, 401);
    }
    const limited = await callApi(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'errada' },
    });
    assert.equal(limited.status, 429);

    // Reseta o rate limit em memória só para testar login válido na mesma suíte criando outro runtime rápido
    const runtime2 = await createRuntime({
      port: 0,
      isTest: true,
      isProduction: false,
      pingSecret,
      sessionEncryptionKey: encKey,
      authCookieSecret: encKey,
      adminPasswordHash: '',
      rateLimitOptions: { loginMax: 20, apiMax: 200 },
    });
    runtime2.shopeeClient.fetchImpl = runtime.shopeeClient.fetchImpl;
    const server2 = http.createServer(runtime2.app);
    await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));
    const baseUrl2 = `http://127.0.0.1:${server2.address().port}`;

    try {
      const provPwd = runtime2.adminBoot.provisionalPassword;
      const loginOk = await callApi(baseUrl2, '/api/auth/login', {
        method: 'POST',
        body: { username: 'admin', password: provPwd },
      });
      assert.equal(loginOk.status, 200);
      assert.equal(loginOk.json.user.mustChangePassword, true);
      const cookie = loginOk.setCookie.split(';')[0];

      // Bloqueado antes da troca de senha
      const blocked = await callApi(baseUrl2, '/api/shopee/config', { cookie });
      assert.equal(blocked.status, 403);
      assert.equal(blocked.json.code, 'PASSWORD_CHANGE_REQUIRED');

      // Troca obrigatória de senha
      const ch = await callApi(baseUrl2, '/api/auth/change-password', {
        method: 'POST',
        cookie,
        body: { currentPassword: provPwd, newPassword: 'SenhaForteFinal#2026' },
      });
      assert.equal(ch.status, 200);
      const cookie2 = ch.setCookie ? ch.setCookie.split(';')[0] : cookie;

      // Bloqueia CSRF sem X-Requested-With
      const csrfFail = await fetch(`${baseUrl2}/api/shopee/config`, {
        method: 'PUT',
        headers: { Cookie: cookie2, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: '123', secretKey: 'segredo_123456', defaultSubId: 'vip' }),
      });
      assert.equal(csrfFail.status, 403);

      // Salva Shopee config com CSRF válido e garante que secretKey nunca volta
      const saveShopee = await callApi(baseUrl2, '/api/shopee/config', {
        method: 'PUT',
        cookie: cookie2,
        body: { appId: '123456', secretKey: 'minha_chave_secreta_shopee', defaultSubId: 'vip' },
      });
      assert.equal(saveShopee.status, 200);
      const getShopee = await callApi(baseUrl2, '/api/shopee/config', { cookie: cookie2 });
      assert.equal(getShopee.status, 200);
      assert.ok(!getShopee.text.includes('minha_chave_secreta_shopee'));

      // Conversor via API
      const conv = await callApi(baseUrl2, '/api/converter/convert', {
        method: 'POST',
        cookie: cookie2,
        body: { url: 'https://shopee.com.br/product/888/777', subId: 'painel' },
      });
      assert.equal(conv.status, 200);
      assert.equal(conv.json.result.shortLink, 'https://shope.ee/painel1');

      // Troca de número exige confirmação explícita
      const switchNoConfirm = await callApi(baseUrl2, '/api/whatsapp/switch-number', {
        method: 'POST',
        cookie: cookie2,
        body: {},
      });
      assert.equal(switchNoConfirm.status, 400);
    } finally {
      await runtime2.dispatcher.stop();
      await new Promise((resolve) => server2.close(resolve));
      await runtime2.redisClient.close();
      await runtime2.pgClient.close();
    }
  } finally {
    await runtime.dispatcher.stop();
    await new Promise((resolve) => server.close(resolve));
    await runtime.redisClient.close();
    await runtime.pgClient.close();
  }
});
