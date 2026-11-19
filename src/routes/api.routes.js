// ==============================================================================
// Rotas da API REST (Keep-Alive, Diagnóstico, Auth e 5 Módulos do Painel)
// ==============================================================================

const express = require('express');

function createApiRouter({ auth, limiters, healthCtrl, authCtrl, panelCtrl }) {
  const router = express.Router();

  // Keep-Alive ultrarrápido para Cloudflare Worker (não consulta banco/Redis/Shopee)
  router.get('/ping', auth.requirePingSecret, healthCtrl.ping);

  // Diagnóstico completo protegido (sessão admin OU ping secret)
  router.get('/health', (req, res, next) => {
    if (req.headers['x-ping-secret'] || (req.headers.authorization || '').toLowerCase().startsWith('bearer ')) {
      return auth.requirePingSecret(req, res, () => healthCtrl.health(req, res, next));
    }
    return auth.requireAuth(req, res, () => healthCtrl.health(req, res, next));
  });

  // Autenticação do painel
  router.post('/auth/login', limiters.loginLimiter, authCtrl.login);
  router.post('/auth/logout', auth.requireCsrf, authCtrl.logout);
  router.get('/auth/me', auth.requireAuth, authCtrl.me);
  router.post('/auth/change-password', limiters.adminLimiter, auth.requireCsrf, auth.requireAuth, authCtrl.changePassword);

  // Demais rotas exigem autenticação + senha provisória já trocada + CSRF em mutações
  router.use(limiters.adminLimiter);
  router.use(auth.requireAuth);
  router.use(auth.requireCsrf);

  // Aba 1: WhatsApp
  router.get('/whatsapp/status', panelCtrl.getWhatsappStatus);
  router.get('/whatsapp/events', panelCtrl.whatsappEvents);
  router.post('/whatsapp/connect', panelCtrl.connectWhatsapp);
  router.post('/whatsapp/disconnect', panelCtrl.disconnectWhatsapp);
  router.post('/whatsapp/switch-number', panelCtrl.switchWhatsappNumber);

  // Aba 2: Shopee
  router.get('/shopee/config', panelCtrl.getShopeeConfig);
  router.put('/shopee/config', panelCtrl.saveShopeeConfig);
  router.post('/shopee/test', panelCtrl.testShopeeConnection);
  router.post('/shopee/search', panelCtrl.searchShopeeProducts);

  // Aba 3: Grupos & Espelhamento
  router.get('/groups', panelCtrl.listGroups);
  router.post('/groups/sync', panelCtrl.syncGroups);
  router.put('/groups/mirror-config', panelCtrl.saveMirrorConfig);
  router.put('/groups/:jid', panelCtrl.updateGroup);
  router.get('/groups/history', panelCtrl.getMirrorHistory);

  // Aba 4: Caçador Automático
  router.get('/hunter/config', panelCtrl.getHunterConfig);
  router.put('/hunter/config', panelCtrl.saveHunterConfig);
  router.post('/hunter/toggle', panelCtrl.toggleHunter);
  router.post('/hunter/keywords', panelCtrl.addHunterKeyword);
  router.delete('/hunter/keywords/:id', panelCtrl.deleteHunterKeyword);
  router.post('/hunter/run-once', panelCtrl.runHunterOnce);

  // Aba 5: Conversor Rápido
  router.post('/converter/convert', panelCtrl.convertUrl);
  router.get('/converter/history', panelCtrl.getConverterHistory);

  // Fila & Auditoria
  router.get('/queue/status', panelCtrl.getQueueAndAudit);

  return router;
}

module.exports = { createApiRouter };
