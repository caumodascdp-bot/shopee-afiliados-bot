// ==============================================================================
// Controlador das 5 Abas do Painel Administrativo e Operação
// ==============================================================================

function createPanelController({
  whatsapp,
  shopeeClient,
  groupManager,
  hunter,
  converter,
  dispatcher,
  repository,
  cryptoHelper,
}) {
  // ---------------- ABA 1: WHATSAPP ----------------
  function getWhatsappStatus(_req, res) {
    return res.json({ ok: true, whatsapp: whatsapp.getStatus() });
  }

  function whatsappEvents(req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (payload) => {
      res.write(`event: status\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    sendEvent(whatsapp.getStatus());

    const onStatus = (st) => sendEvent(st);
    whatsapp.on('status', onStatus);

    const keepAlive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 20000);
    if (typeof keepAlive.unref === 'function') keepAlive.unref();

    req.on('close', () => {
      clearInterval(keepAlive);
      whatsapp.off('status', onStatus);
    });
  }

  async function connectWhatsapp(req, res, next) {
    try {
      const status = await whatsapp.connect({ isRetry: false });
      await repository.addAuditLog({
        actor: req.adminUser.username,
        action: 'whatsapp.connect',
        resource: 'whatsapp',
        details: { status: status.status },
        ipAddress: req.ip || '',
      });
      return res.json({ ok: true, whatsapp: status });
    } catch (err) {
      return next(err);
    }
  }

  async function disconnectWhatsapp(req, res, next) {
    try {
      const status = await whatsapp.disconnect();
      await repository.addAuditLog({
        actor: req.adminUser.username,
        action: 'whatsapp.disconnect',
        resource: 'whatsapp',
        details: {},
        ipAddress: req.ip || '',
      });
      return res.json({ ok: true, whatsapp: status });
    } catch (err) {
      return next(err);
    }
  }

  async function switchWhatsappNumber(req, res, next) {
    try {
      if (req.body?.confirm !== true) {
        return res.status(400).json({
          error: 'Confirmação explícita obrigatória para trocar o número do WhatsApp.',
          code: 'CONFIRMATION_REQUIRED',
        });
      }
      const status = await whatsapp.switchNumber();
      await repository.addAuditLog({
        actor: req.adminUser.username,
        action: 'whatsapp.switch_number',
        resource: 'whatsapp',
        details: {},
        ipAddress: req.ip || '',
      });
      return res.json({ ok: true, whatsapp: status });
    } catch (err) {
      return next(err);
    }
  }

  // ---------------- ABA 2: SHOPEE ----------------
  async function getShopeeConfig(_req, res, next) {
    try {
      const creds = await shopeeClient.getCredentials();
      return res.json({
        ok: true,
        config: {
          appId: creds.appId,
          hasSecretKey: creds.hasSecretKey,
          secretKeyMasked: creds.hasSecretKey ? cryptoHelper.maskSecret(creds.secretKey) : '',
          defaultSubId: creds.defaultSubId,
          lastTestedAt: creds.lastTestedAt,
          lastTestStatus: creds.lastTestStatus,
          lastTestError: creds.lastTestError,
        },
      });
    } catch (err) {
      return next(err);
    }
  }

  async function saveShopeeConfig(req, res, next) {
    try {
      const { appId, secretKey, defaultSubId } = req.body || {};
      const saved = await shopeeClient.saveCredentials({ appId, secretKey, defaultSubId });
      await repository.addAuditLog({
        actor: req.adminUser.username,
        action: 'shopee.save_config',
        resource: 'shopee_credentials',
        details: { appId: saved.appId, defaultSubId: saved.defaultSubId, secretUpdated: Boolean(secretKey) },
        ipAddress: req.ip || '',
      });
      return res.json({ ok: true, config: saved });
    } catch (err) {
      return next(err);
    }
  }

  async function testShopeeConnection(req, res, next) {
    try {
      const result = await shopeeClient.testConnection();
      await repository.addAuditLog({
        actor: req.adminUser.username,
        action: 'shopee.test_connection',
        resource: 'shopee_credentials',
        details: { ok: result.ok, code: result.code || null },
        ipAddress: req.ip || '',
      });
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      return next(err);
    }
  }

  async function searchShopeeProducts(req, res, next) {
    try {
      const { keyword = '', page = 1, limit = 10, sortType = 5 } = req.body || {};
      const result = await shopeeClient.searchProducts({ keyword, page, limit, sortType, useCache: false });
      return res.json({ ok: true, ...result });
    } catch (err) {
      return next(err);
    }
  }

  // ---------------- ABA 3: GRUPOS & ESPELHAMENTO ----------------
  async function listGroups(_req, res, next) {
    try {
      const [groups, mirrorConfig] = await Promise.all([
        groupManager.listGroups(),
        groupManager.getMirrorConfig(),
      ]);
      return res.json({ ok: true, groups, mirrorConfig });
    } catch (err) {
      return next(err);
    }
  }

  async function syncGroups(req, res, next) {
    try {
      const groups = await groupManager.syncGroupsFromWhatsApp();
      await repository.addAuditLog({
        actor: req.adminUser.username,
        action: 'groups.sync',
        resource: 'whatsapp_groups',
        details: { total: groups.length },
        ipAddress: req.ip || '',
      });
      return res.json({ ok: true, groups });
    } catch (err) {
      const status = err.message.includes('não conectado') ? 409 : 500;
      if (status === 409) return res.status(409).json({ error: err.message, code: 'WHATSAPP_DISCONNECTED' });
      return next(err);
    }
  }

  async function updateGroup(req, res, next) {
    try {
      const jid = decodeURIComponent(req.params.jid || '');
      const { isSource, isDestination, rules } = req.body || {};
      const updated = await groupManager.updateGroup(jid, { isSource, isDestination, rules });
      await repository.addAuditLog({
        actor: req.adminUser.username,
        action: 'groups.update',
        resource: jid,
        details: { isSource, isDestination },
        ipAddress: req.ip || '',
      });
      return res.json({ ok: true, group: updated });
    } catch (err) {
      if (err.message.includes('JID')) return res.status(400).json({ error: err.message, code: 'INVALID_JID' });
      return next(err);
    }
  }

  async function saveMirrorConfig(req, res, next) {
    try {
      const mirrorConfig = await groupManager.setMirrorConfig(req.body || {});
      await repository.addAuditLog({
        actor: req.adminUser.username,
        action: 'groups.mirror_config',
        resource: 'app_settings',
        details: mirrorConfig,
        ipAddress: req.ip || '',
      });
      return res.json({ ok: true, mirrorConfig });
    } catch (err) {
      return next(err);
    }
  }

  async function getMirrorHistory(_req, res, next) {
    try {
      const [offers, publications] = await Promise.all([
        repository.listOffers({ sourceType: 'group_mirror', limit: 30 }),
        repository.listPublications(30),
      ]);
      return res.json({ ok: true, offers, publications });
    } catch (err) {
      return next(err);
    }
  }

  // ---------------- ABA 4: CAÇADOR AUTOMÁTICO ----------------
  async function getHunterConfig(_req, res, next) {
    try {
      const [config, keywords, offers] = await Promise.all([
        hunter.getConfig(),
        repository.listHunterKeywords(),
        repository.listOffers({ sourceType: 'hunter', limit: 30 }),
      ]);
      return res.json({ ok: true, config, keywords, offers });
    } catch (err) {
      return next(err);
    }
  }

  async function saveHunterConfig(req, res, next) {
    try {
      const config = await hunter.saveConfig(req.body || {});
      await repository.addAuditLog({
        actor: req.adminUser.username,
        action: 'hunter.save_config',
        resource: 'app_settings',
        details: { enabled: config.enabled, intervalMinutes: config.intervalMinutes },
        ipAddress: req.ip || '',
      });
      return res.json({ ok: true, config });
    } catch (err) {
      return next(err);
    }
  }

  async function toggleHunter(req, res, next) {
    try {
      const enabled = Boolean(req.body?.enabled);
      const config = await hunter.saveConfig({ enabled });
      await repository.addAuditLog({
        actor: req.adminUser.username,
        action: enabled ? 'hunter.enabled' : 'hunter.paused',
        resource: 'app_settings',
        details: { enabled },
        ipAddress: req.ip || '',
      });
      return res.json({ ok: true, config });
    } catch (err) {
      return next(err);
    }
  }

  async function addHunterKeyword(req, res, next) {
    try {
      const kw = await repository.addHunterKeyword(req.body || {});
      await repository.addAuditLog({
        actor: req.adminUser.username,
        action: 'hunter.keyword_added',
        resource: 'hunter_keywords',
        details: { keyword: kw.keyword },
        ipAddress: req.ip || '',
      });
      return res.status(201).json({ ok: true, keyword: kw });
    } catch (err) {
      if (err.message.includes('obrigatória')) return res.status(400).json({ error: err.message, code: 'INVALID_KEYWORD' });
      return next(err);
    }
  }

  async function deleteHunterKeyword(req, res, next) {
    try {
      const deleted = await repository.deleteHunterKeyword(req.params.id);
      if (!deleted) return res.status(404).json({ error: 'Palavra-chave não encontrada.', code: 'NOT_FOUND' });
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  }

  async function runHunterOnce(req, res, next) {
    try {
      const result = await hunter.runCycle({ forceManual: true });
      await repository.addAuditLog({
        actor: req.adminUser.username,
        action: 'hunter.run_manual',
        resource: 'hunter',
        details: { offersSelected: result.offersSelected || 0, enqueued: result.enqueued || 0 },
        ipAddress: req.ip || '',
      });
      return res.json({ ok: true, result });
    } catch (err) {
      return next(err);
    }
  }

  // ---------------- ABA 5: CONVERSOR RÁPIDO ----------------
  async function convertUrl(req, res, next) {
    try {
      const { url, subId } = req.body || {};
      const subIds = subId ? String(subId).split(',').map((s) => s.trim()).filter(Boolean) : [];
      const result = await converter.convertLink({
        url,
        subIds,
        requestedVia: 'panel',
        requesterRef: req.adminUser.username,
      });
      return res.json({ ok: true, result });
    } catch (err) {
      return next(err);
    }
  }

  async function getConverterHistory(_req, res, next) {
    try {
      const history = await repository.listConversions(30);
      return res.json({ ok: true, history });
    } catch (err) {
      return next(err);
    }
  }

  // ---------------- FILA & AUDITORIA ----------------
  async function getQueueAndAudit(_req, res, next) {
    try {
      const [queue, publications, audit] = await Promise.all([
        repository.getQueueStats(),
        repository.listPublications(30),
        repository.listAuditLogs(40),
      ]);
      return res.json({
        ok: true,
        queue,
        publications,
        audit,
        dispatcherActive: Boolean(dispatcher?._running),
      });
    } catch (err) {
      return next(err);
    }
  }

  return {
    getWhatsappStatus,
    whatsappEvents,
    connectWhatsapp,
    disconnectWhatsapp,
    switchWhatsappNumber,
    getShopeeConfig,
    saveShopeeConfig,
    testShopeeConnection,
    searchShopeeProducts,
    listGroups,
    syncGroups,
    updateGroup,
    saveMirrorConfig,
    getMirrorHistory,
    getHunterConfig,
    saveHunterConfig,
    toggleHunter,
    addHunterKeyword,
    deleteHunterKeyword,
    runHunterOnce,
    convertUrl,
    getConverterHistory,
    getQueueAndAudit,
  };
}

module.exports = { createPanelController };
