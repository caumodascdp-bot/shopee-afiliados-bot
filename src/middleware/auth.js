// ==============================================================================
// Autenticação Administrativa, Troca Obrigatória de Senha, CSRF e Ping Secret
// ==============================================================================

const logger = require('../utils/logger');
const {
  hashPassword,
  verifyPassword,
  signAuthToken,
  verifyAuthToken,
  timingSafeCompareText,
  generateRandomSecret,
} = require('../utils/crypto');

const SESSION_COOKIE = 'shopee_admin_session';

function parseCookies(cookieHeader = '') {
  const out = {};
  if (!cookieHeader || typeof cookieHeader !== 'string') return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch (_) {
        out[key] = val;
      }
    }
  }
  return out;
}

async function ensureAdminProvisioned({ repository, config }) {
  const existing = await repository.getAdminByUsername('admin');
  if (existing) {
    return {
      created: false,
      mustChangePassword: Boolean(existing.must_change_password),
      provisionalPassword: null,
    };
  }

  if (config.adminPasswordHash) {
    await repository.upsertAdminUser({
      username: 'admin',
      passwordHash: config.adminPasswordHash,
      mustChangePassword: false,
    });
    return { created: true, mustChangePassword: false, provisionalPassword: null };
  }

  // Gera senha provisória aleatória em runtime (nunca senha fixa no código)
  const provisionalPassword = `Tmp#${generateRandomSecret(9)}`;
  const passwordHash = hashPassword(provisionalPassword);
  await repository.upsertAdminUser({
    username: 'admin',
    passwordHash,
    mustChangePassword: true,
  });

  logger.warn('[SEGURANCA] Usuário admin inicial criado com senha provisória temporária. Troca obrigatória no primeiro login.');
  return {
    created: true,
    mustChangePassword: true,
    provisionalPassword,
  };
}

function createAuthMiddleware({ repository, config }) {
  const cookieSecret = config.authCookieSecret || config.sessionEncryptionKey || 'dev-ephemeral-cookie-secret-123456';

  function issueSessionCookie(res, user) {
    const token = signAuthToken(
      { sub: user.username || 'admin', uid: user.id || 1 },
      cookieSecret,
      12 * 3600
    );
    const flags = [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      'HttpOnly',
      'Path=/',
      'SameSite=Strict',
      'Max-Age=43200',
    ];
    if (config.isProduction && process.env.ALLOW_INSECURE_HTTP_COOKIE !== 'true') {
      flags.push('Secure');
    }
    res.setHeader('Set-Cookie', flags.join('; '));
  }

  function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
  }

  async function requireAuth(req, res, next) {
    try {
      const cookies = parseCookies(req.headers.cookie || '');
      const token = cookies[SESSION_COOKIE];
      const payload = verifyAuthToken(token, cookieSecret);
      if (!payload) {
        return res.status(401).json({ error: 'Sessão expirada ou não autenticada.', code: 'UNAUTHORIZED' });
      }

      const user = await repository.getAdminByUsername(payload.sub || 'admin');
      if (!user) {
        return res.status(401).json({ error: 'Usuário administrativo inválido.', code: 'UNAUTHORIZED' });
      }

      req.adminUser = {
        id: user.id,
        username: user.username,
        mustChangePassword: Boolean(user.must_change_password),
      };

      const allowedWhenMustChange = new Set([
        '/api/auth/me',
        '/api/auth/logout',
        '/api/auth/change-password',
      ]);

      const fullPath = `${req.baseUrl || ''}${req.path || ''}`;
      if (req.adminUser.mustChangePassword && !allowedWhenMustChange.has(fullPath) && !allowedWhenMustChange.has(req.path)) {
        return res.status(403).json({
          error: 'Troca obrigatória da senha provisória antes de operar o painel.',
          code: 'PASSWORD_CHANGE_REQUIRED',
        });
      }

      return next();
    } catch (err) {
      return next(err);
    }
  }

  function requireCsrf(req, res, next) {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return next();
    }
    // Exige cabeçalho customizado X-Requested-With para impedir envio simples por formulários cross-site
    const xrw = String(req.headers['x-requested-with'] || '');
    if (xrw !== 'XMLHttpRequest') {
      return res.status(403).json({
        error: 'Cabeçalho CSRF (X-Requested-With) ausente ou inválido.',
        code: 'CSRF_REJECTED',
      });
    }
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin && host) {
      try {
        const originHost = new URL(origin).host;
        if (originHost !== host) {
          return res.status(403).json({ error: 'Origem da requisição não permitida (CSRF).', code: 'CSRF_ORIGIN_MISMATCH' });
        }
      } catch (_) {
        return res.status(403).json({ error: 'Cabeçalho Origin inválido.', code: 'CSRF_REJECTED' });
      }
    }
    return next();
  }

  function requirePingSecret(req, res, next) {
    const secret = String(config.pingSecret || '').trim();
    if (!secret) {
      return res.status(503).json({
        ok: false,
        error: 'PING_SECRET não configurado no servidor.',
        code: 'PING_SECRET_NOT_CONFIGURED',
      });
    }
    const headerSecret = String(req.headers['x-ping-secret'] || '').trim();
    const authHeader = String(req.headers.authorization || '').trim();
    const bearerSecret = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
    const candidate = headerSecret || bearerSecret;

    if (!timingSafeCompareText(candidate, secret)) {
      return res.status(401).json({ ok: false, error: 'Não autorizado.', code: 'INVALID_PING_SECRET' });
    }
    return next();
  }

  function verifyAdminPassword(plain, user) {
    return verifyPassword(plain, user.password_hash);
  }

  return {
    issueSessionCookie,
    clearSessionCookie,
    requireAuth,
    requireCsrf,
    requirePingSecret,
    verifyAdminPassword,
    hashPassword,
  };
}

module.exports = {
  SESSION_COOKIE,
  parseCookies,
  ensureAdminProvisioned,
  createAuthMiddleware,
};
