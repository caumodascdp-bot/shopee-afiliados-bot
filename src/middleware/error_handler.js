// ==============================================================================
// Tratamento Global de Erros HTTP sem vazamento de segredos ou stack trace
// ==============================================================================

const logger = require('../utils/logger');
const { higienizarTextoSegredos } = require('../utils/filtro_log_criptografia');

function errorHandler(err, req, res, _next) {
  const statusCode = Number(err?.statusCode) || 500;
  const code = err?.code || (statusCode >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
  const safeMsg = higienizarTextoSegredos(err?.message || 'Erro interno no servidor.');

  logger.error(`[HTTP ${statusCode}] ${req.method} ${req.originalUrl}: ${safeMsg}`);

  if (res.headersSent) return;
  res.status(statusCode).json({
    error: statusCode >= 500 && process.env.NODE_ENV === 'production' ? 'Erro interno no servidor.' : safeMsg,
    code,
  });
}

module.exports = { errorHandler };
