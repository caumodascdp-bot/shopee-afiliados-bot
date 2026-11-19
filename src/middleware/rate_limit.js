// ==============================================================================
// Rate Limiting para Login e Rotas Administrativas
// ==============================================================================

const rateLimit = require('express-rate-limit');

function createLimiters(options = {}) {
  const loginMax = Number(options.loginMax) || 10;
  const apiMax = Number(options.apiMax) || 120;

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: loginMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: 'Muitas tentativas de login. Aguarde alguns minutos e tente novamente.',
      code: 'RATE_LIMITED',
    },
  });

  const adminLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: apiMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: 'Limite de requisições administrativas por minuto excedido.',
      code: 'RATE_LIMITED',
    },
  });

  return { loginLimiter, adminLimiter };
}

module.exports = { createLimiters };
