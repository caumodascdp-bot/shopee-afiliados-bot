// ==============================================================================
// Montagem do App Express (Helmet, JSON, Estáticos e API REST)
// Base estrutural adaptada de gabrieldamasse-01/bot-de-automacao
// ==============================================================================

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { createAuthMiddleware } = require('./middleware/auth');
const { createLimiters } = require('./middleware/rate_limit');
const { errorHandler } = require('./middleware/error_handler');
const { createHealthController } = require('./controllers/health.controller');
const { createAuthController } = require('./controllers/auth.controller');
const { createPanelController } = require('./controllers/panel.controller');
const { createApiRouter } = require('./routes/api.routes');

function createApp({
  config,
  pgClient,
  redisClient,
  repository,
  whatsapp,
  shopeeClient,
  groupManager,
  hunter,
  converter,
  dispatcher,
  cryptoHelper,
  rateLimitOptions = {},
}) {
  const app = express();
  app.set('trust proxy', 1);

  // Em modo local/HTTP (ex.: teste via Tailscale), evita HSTS e upgrade forçado para HTTPS
  const allowPlainHttp = !config.isProduction || process.env.ALLOW_INSECURE_HTTP_COOKIE === 'true';

  app.use(
    helmet({
      ...(allowPlainHttp
        ? {
            hsts: false,
            crossOriginOpenerPolicy: false,
            originAgentCluster: false,
          }
        : {}),
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https://*.susercontent.com', 'https://cf.shopee.com.br'],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          ...(allowPlainHttp ? { upgradeInsecureRequests: null } : {}),
        },
      },
    })
  );

  app.use(express.json({ limit: '512kb' }));

  const auth = createAuthMiddleware({ repository, config });
  const limiters = createLimiters(rateLimitOptions);
  const healthCtrl = createHealthController({ pgClient, redisClient, whatsapp, repository, config });
  const authCtrl = createAuthController({ repository, auth });
  const panelCtrl = createPanelController({
    whatsapp,
    shopeeClient,
    groupManager,
    hunter,
    converter,
    dispatcher,
    repository,
    cryptoHelper,
  });

  app.use('/api', createApiRouter({ auth, limiters, healthCtrl, authCtrl, panelCtrl }));

  const publicDir = path.join(config.rootDir, 'public');
  app.use(express.static(publicDir, { index: 'index.html' }));

  app.get('/', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
