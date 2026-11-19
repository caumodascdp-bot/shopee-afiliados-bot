// ==============================================================================
// Cloudflare Worker Exclusivo: Keep-Alive Shopee Afiliados (Cron 10 minutos)
// Independente — não altera e não reutiliza nenhum Worker existente.
// ==============================================================================

const lastExecution = {
  timestamp: null,
  ok: null,
  statusCode: null,
  latencyMs: null,
  error: null,
};

async function executePing(env, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const baseUrl = String(env?.RENDER_BASE_URL || '').trim().replace(/\/+$/, '');
  const secret = String(env?.PING_SECRET || '').trim();
  const startedAt = Date.now();

  if (!baseUrl) {
    const result = {
      timestamp: new Date().toISOString(),
      ok: false,
      statusCode: null,
      latencyMs: 0,
      error: 'RENDER_BASE_URL não configurada.',
    };
    Object.assign(lastExecution, result);
    console.error('[KEEP-ALIVE]', JSON.stringify(result));
    return result;
  }

  if (!secret) {
    const result = {
      timestamp: new Date().toISOString(),
      ok: false,
      statusCode: null,
      latencyMs: 0,
      error: 'PING_SECRET não configurado no Worker.',
    };
    Object.assign(lastExecution, result);
    console.error('[KEEP-ALIVE]', JSON.stringify(result));
    return result;
  }

  const targetUrl = `${baseUrl}/api/ping`;
  try {
    const response = await fetchImpl(targetUrl, {
      method: 'GET',
      headers: {
        'x-ping-secret': secret,
        Accept: 'application/json',
        'User-Agent': 'ShopeeAfiliados-KeepAlive-Worker/1.0',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    const latencyMs = Date.now() - startedAt;
    const ok = response.status >= 200 && response.status < 300;
    let bodySnippet = '';
    try {
      bodySnippet = (await response.text()).slice(0, 200);
    } catch (_) {}

    const result = {
      timestamp: new Date().toISOString(),
      ok,
      statusCode: response.status,
      latencyMs,
      error: ok ? null : `HTTP ${response.status}: ${bodySnippet}`,
    };
    Object.assign(lastExecution, result);

    if (ok) {
      console.log('[KEEP-ALIVE] OK', JSON.stringify(result));
    } else {
      console.warn('[KEEP-ALIVE] FALHA', JSON.stringify(result));
    }
    return result;
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const result = {
      timestamp: new Date().toISOString(),
      ok: false,
      statusCode: null,
      latencyMs,
      error: err?.name === 'TimeoutError' ? `Timeout após ${timeoutMs}ms` : err?.message || 'Erro de rede',
    };
    Object.assign(lastExecution, result);
    console.error('[KEEP-ALIVE] ERRO', JSON.stringify(result));
    return result;
  }
}

export default {
  async scheduled(_event, env, ctx) {
    const promise = executePing(env);
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(promise);
    }
    return promise;
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const provided = request.headers.get('x-ping-secret') || '';
    const expected = String(env?.PING_SECRET || '');

    if (!expected || provided !== expected) {
      return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.pathname === '/run') {
      const res = await executePing(env);
      return new Response(JSON.stringify(res, null, 2), {
        status: res.ok ? 200 : 502,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ service: 'shopee-afiliados-keepalive', lastExecution }, null, 2), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
};

export { executePing, lastExecution };
