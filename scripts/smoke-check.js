// ==============================================================================
// Smoke Check Real na Porta 3850
// Valida inicialização, /api/ping com PING_SECRET, login, troca obrigatória
// de senha provisória, /api/health e encerramento gracioso.
// ==============================================================================

const http = require('http');
const crypto = require('crypto');
const { createRuntime } = require('../index');

async function reqJson(baseUrl, path, { method = 'GET', body = null, headers = {}, cookie = '' } = {}) {
  const reqHeaders = {
    'X-Requested-With': 'XMLHttpRequest',
    ...headers,
  };
  if (cookie) reqHeaders.Cookie = cookie;
  if (body !== null) reqHeaders['Content-Type'] = 'application/json';

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: reqHeaders,
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie') || '';
  const data = await res.json().catch(() => null);
  return { status: res.status, data, setCookie };
}

async function main() {
  const pingSecret = crypto.randomBytes(16).toString('hex');
  const encryptionKey = crypto.randomBytes(24).toString('hex');

  const runtime = await createRuntime({
    port: 3850,
    isTest: true,
    isProduction: false,
    pingSecret,
    sessionEncryptionKey: encryptionKey,
    authCookieSecret: encryptionKey,
    adminPasswordHash: '',
  });

  const server = http.createServer(runtime.app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(3850, '127.0.0.1', resolve);
  });

  const baseUrl = 'http://127.0.0.1:3850';
  try {
    // 1. HTML do painel
    const rootRes = await fetch(`${baseUrl}/`);
    if (rootRes.status !== 200) throw new Error(`GET / retornou ${rootRes.status}`);

    // 2. /api/ping sem segredo deve falhar (401)
    const pingNoAuth = await reqJson(baseUrl, '/api/ping');
    if (pingNoAuth.status !== 401) throw new Error(`/api/ping sem segredo retornou ${pingNoAuth.status}`);

    // 3. /api/ping com segredo deve responder 200 rápido
    const t0 = Date.now();
    const pingOk = await reqJson(baseUrl, '/api/ping', { headers: { 'x-ping-secret': pingSecret } });
    const pingMs = Date.now() - t0;
    if (pingOk.status !== 200 || !pingOk.data?.ok) throw new Error(`/api/ping falhou: ${pingOk.status}`);

    // 4. Login com senha provisória gerada no boot
    const provPwd = runtime.adminBoot.provisionalPassword;
    if (!provPwd) throw new Error('Senha provisória não foi gerada no boot.');
    const loginRes = await reqJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: provPwd },
    });
    if (loginRes.status !== 200 || !loginRes.data?.user?.mustChangePassword) {
      throw new Error(`Login provisório inesperado: ${loginRes.status}`);
    }
    const cookie = loginRes.setCookie.split(';')[0];

    // 5. Rota operacional deve ser bloqueada (403 PASSWORD_CHANGE_REQUIRED) antes de trocar a senha
    const blockedRes = await reqJson(baseUrl, '/api/whatsapp/status', { cookie });
    if (blockedRes.status !== 403 || blockedRes.data?.code !== 'PASSWORD_CHANGE_REQUIRED') {
      throw new Error(`Esperado 403 PASSWORD_CHANGE_REQUIRED, obtido ${blockedRes.status}`);
    }

    // 6. Troca obrigatória da senha provisória
    const newPwd = 'NovaSenhaSegura#2026';
    const changeRes = await reqJson(baseUrl, '/api/auth/change-password', {
      method: 'POST',
      cookie,
      body: { currentPassword: provPwd, newPassword: newPwd },
    });
    if (changeRes.status !== 200) throw new Error(`Troca de senha falhou: ${changeRes.status}`);
    const freshCookie = changeRes.setCookie ? changeRes.setCookie.split(';')[0] : cookie;

    // 7. Acesso ao /api/health liberado após troca
    const healthRes = await reqJson(baseUrl, '/api/health', { cookie: freshCookie });
    if (healthRes.status !== 200 || !healthRes.data?.ok) throw new Error(`/api/health falhou: ${healthRes.status}`);

    console.log(
      JSON.stringify(
        {
          smoke: 'PASSED',
          port: 3850,
          pingLatencyMs: pingMs,
          rssMb: healthRes.data.memoryMb.rss,
          heapUsedMb: healthRes.data.memoryMb.heapUsed,
        },
        null,
        2
      )
    );
  } finally {
    await runtime.dispatcher.stop();
    await runtime.whatsapp.disconnect();
    await new Promise((resolve) => server.close(() => resolve()));
    await runtime.redisClient.close();
    await runtime.pgClient.close();
  }
}

main().catch((err) => {
  console.error('SMOKE CHECK FAILED:', err.message);
  process.exit(1);
});
