const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

test('Cloudflare Worker: executa ping autenticado no cron, trata falha HTTP 500/timeout e protege /run', async () => {
  const workerUrl = pathToFileURL(path.resolve(__dirname, '../cloudflare-worker/src/worker.js')).href;
  const mod = await import(workerUrl);
  const { executePing } = mod;
  const worker = mod.default;

  // 1. Ping com sucesso
  const seenRequests = [];
  const resOk = await executePing(
    { RENDER_BASE_URL: 'https://shopee-demo.onrender.com/', PING_SECRET: 'segredo-ping-123' },
    {
      fetchImpl: async (url, opts) => {
        seenRequests.push({ url, opts });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }
  );
  assert.equal(resOk.ok, true);
  assert.equal(resOk.statusCode, 200);
  assert.equal(seenRequests[0].url, 'https://shopee-demo.onrender.com/api/ping');
  assert.equal(seenRequests[0].opts.headers['x-ping-secret'], 'segredo-ping-123');

  // 2. Indisponibilidade HTTP 503
  const resErr = await executePing(
    { RENDER_BASE_URL: 'https://shopee-demo.onrender.com', PING_SECRET: 'segredo-ping-123' },
    {
      fetchImpl: async () => new Response('Service Unavailable', { status: 503 }),
    }
  );
  assert.equal(resErr.ok, false);
  assert.equal(resErr.statusCode, 503);
  assert.match(resErr.error, /HTTP 503/);

  // 3. Timeout tratado sem crash
  const resTimeout = await executePing(
    { RENDER_BASE_URL: 'https://shopee-demo.onrender.com', PING_SECRET: 'segredo-ping-123' },
    {
      fetchImpl: async () => {
        const e = new Error('The operation timed out');
        e.name = 'TimeoutError';
        throw e;
      },
    }
  );
  assert.equal(resTimeout.ok, false);
  assert.match(resTimeout.error, /Timeout/);

  // 4. Fetch handler bloqueia acesso sem PING_SECRET e responde quando autenticado
  const unauthResp = await worker.fetch(new Request('https://worker.example/'), { PING_SECRET: 'segredo-ping-123' });
  assert.equal(unauthResp.status, 401);

  const authResp = await worker.fetch(
    new Request('https://worker.example/', { headers: { 'x-ping-secret': 'segredo-ping-123' } }),
    { PING_SECRET: 'segredo-ping-123' }
  );
  assert.equal(authResp.status, 200);
  const authBody = await authResp.json();
  assert.equal(authBody.service, 'shopee-afiliados-keepalive');
});
