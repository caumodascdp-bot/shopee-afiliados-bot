(() => {
  const $ = (id) => document.getElementById(id);
  let sseSource = null;
  let currentHunterEnabled = false;

  function showToast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 3500);
  }

  async function api(path, { method = 'GET', body = null } = {}) {
    const headers = { 'X-Requested-With': 'XMLHttpRequest' };
    if (body !== null) {
      headers['Content-Type'] = 'application/json';
    }
    const resp = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body !== null ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(data.error || `Erro HTTP ${resp.status}`);
      err.code = data.code;
      err.status = resp.status;
      throw err;
    }
    return data;
  }

  function showView(viewId) {
    $('loginView').classList.add('hidden');
    $('changePasswordView').classList.add('hidden');
    $('appShell').classList.add('hidden');
    $(viewId).classList.remove('hidden');
  }

  function activateTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${tabName}`);
    });
  }

  function renderWaStatus(wa) {
    if (!wa) return;
    const badge = $('waStatusBadge');
    const dot = $('headerWaDot');
    const headerText = $('headerWaText');
    badge.textContent = wa.status || 'OFFLINE';
    badge.className = 'pill ' + (wa.connected ? 'ok' : wa.status === 'QR_CODE' ? 'warn' : 'err');
    dot.className = 'dot ' + (wa.connected ? 'ok' : wa.status === 'QR_CODE' ? 'warn' : '');
    headerText.textContent = wa.connected ? `Conectado (${wa.phone || 'WA'})` : wa.status || 'Desconectado';

    $('waPhoneValue').textContent = wa.phone || '—';
    $('waSessionIdValue').textContent = wa.sessionId || '—';
    $('waConnectedAtValue').textContent = wa.connectedAt ? new Date(wa.connectedAt).toLocaleString('pt-BR') : '—';
    $('waReconnectValue').textContent = String(wa.reconnectAttempts || 0);

    if (wa.lastError) {
      $('waErrorBox').textContent = wa.lastError;
      $('waErrorBox').classList.remove('hidden');
    } else {
      $('waErrorBox').classList.add('hidden');
    }

    if (wa.qrDataUrl && !wa.connected) {
      $('waQrImg').src = wa.qrDataUrl;
      $('waQrBox').classList.remove('hidden');
    } else {
      $('waQrBox').classList.add('hidden');
    }
  }

  function startSse() {
    if (sseSource) sseSource.close();
    sseSource = new EventSource('/api/whatsapp/events');
    sseSource.addEventListener('status', (ev) => {
      try {
        renderWaStatus(JSON.parse(ev.data));
      } catch (_) {}
    });
  }

  async function loadHealth() {
    try {
      const h = await api('/api/health');
      const pgTxt = h.dependencies?.postgres?.ok ? 'Neon conectado' : `PostgreSQL (${h.dependencies?.postgres?.mode || 'fallback'})`;
      const rdTxt = h.dependencies?.redis?.ok ? 'Upstash conectado' : `Redis (${h.dependencies?.redis?.mode || 'fallback'})`;
      $('systemSummary').innerHTML = [
        `RAM atual (RSS): <strong>${h.memoryMb?.rss ?? '?'} MB</strong> (Heap: ${h.memoryMb?.heapUsed ?? '?'} MB)`,
        `Banco: <strong>${pgTxt}</strong> • Cache/Fila: <strong>${rdTxt}</strong>`,
        `Fila pendente: <strong>${h.queue?.pending ?? 0}</strong> • Enviadas: <strong>${h.queue?.sent ?? 0}</strong> • Falhas definitivas: <strong>${h.queue?.dead_letter ?? 0}</strong>`,
      ].join('<br>');
    } catch (err) {
      $('systemSummary').textContent = err.message;
    }
  }

  async function loadShopee() {
    const data = await api('/api/shopee/config');
    const c = data.config;
    $('shopeeAppId').value = c.appId || '';
    $('shopeeDefaultSubId').value = c.defaultSubId || 'whatsapp_grupos';
    $('shopeeSecretKey').value = '';
    $('shopeeSecretHint').textContent = c.hasSecretKey ? `(salva: ${c.secretKeyMasked})` : '(não configurada)';

    const badge = $('shopeeStatusBadge');
    if (c.lastTestStatus === 'ok') {
      badge.textContent = 'Conectada';
      badge.className = 'pill ok';
    } else if (c.lastTestStatus === 'error') {
      badge.textContent = 'Erro no teste';
      badge.className = 'pill err';
    } else {
      badge.textContent = 'Não testada';
      badge.className = 'pill';
    }
  }

  async function loadGroups() {
    const data = await api('/api/groups');
    const m = data.mirrorConfig || {};
    $('mirrorEnabled').checked = Boolean(m.enabled);
    $('privateConverterEnabled').checked = Boolean(m.privateConverterEnabled);
    $('mirrorIncludeImage').checked = m.includeImage !== false;
    $('mirrorDedupHours').value = m.dedupHours || 12;
    $('mirrorSubId').value = m.subIdOverride || '';

    const container = $('groupsList');
    container.innerHTML = '';
    if (!data.groups || data.groups.length === 0) {
      container.innerHTML = '<p class="muted">Nenhum grupo sincronizado ainda. Conecte o WhatsApp e clique em Sincronizar Grupos.</p>';
      return;
    }

    for (const g of data.groups) {
      const card = document.createElement('div');
      card.className = 'item-card';
      card.innerHTML = `
        <div class="item-row">
          <div>
            <strong>${escapeHtml(g.name || g.jid)}</strong>
            <div class="mono muted">${escapeHtml(g.jid)} (${g.participants_count || 0} membros)</div>
          </div>
          <div class="btn-row">
            <label class="toggle-row">
              <input type="checkbox" class="grp-src" ${g.is_source ? 'checked' : ''}>
              <span>Origem</span>
            </label>
            <label class="toggle-row">
              <input type="checkbox" class="grp-dst" ${g.is_destination ? 'checked' : ''}>
              <span>Destino</span>
            </label>
          </div>
        </div>
      `;
      const srcEl = card.querySelector('.grp-src');
      const dstEl = card.querySelector('.grp-dst');
      const saveGroupFlags = async () => {
        try {
          await api(`/api/groups/${encodeURIComponent(g.jid)}`, {
            method: 'PUT',
            body: { isSource: srcEl.checked, isDestination: dstEl.checked },
          });
          showToast(`Grupo "${g.name || g.jid}" atualizado.`);
        } catch (err) {
          showToast(err.message);
        }
      };
      srcEl.addEventListener('change', saveGroupFlags);
      dstEl.addEventListener('change', saveGroupFlags);
      container.appendChild(card);
    }
  }

  async function loadHunter() {
    const data = await api('/api/hunter/config');
    const c = data.config || {};
    currentHunterEnabled = Boolean(c.enabled);
    $('hunterMinCommission').value = c.minCommissionPercent ?? 5;
    $('hunterIntervalMinutes').value = c.intervalMinutes ?? 60;
    $('hunterMinPrice').value = c.minPrice ?? 0;
    $('hunterMaxPrice').value = c.maxPrice ?? 0;
    $('hunterMinSales').value = c.minSales ?? 0;
    $('hunterMaxPerRun').value = c.maxPerRun ?? 3;
    $('hunterSubId').value = c.subId || 'cacador_auto';

    const badge = $('hunterStatusBadge');
    badge.textContent = currentHunterEnabled ? 'ATIVO' : 'PAUSADO';
    badge.className = 'pill ' + (currentHunterEnabled ? 'ok' : 'warn');
    $('hunterToggleBtn').textContent = currentHunterEnabled ? 'Pausar Piloto Automático' : 'Ligar Piloto Automático';

    const kwList = $('keywordsList');
    kwList.innerHTML = '';
    for (const kw of data.keywords || []) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = `<span>${escapeHtml(kw.keyword)}</span><button type="button" title="Remover">×</button>`;
      chip.querySelector('button').addEventListener('click', async () => {
        await api(`/api/hunter/keywords/${kw.id}`, { method: 'DELETE' });
        await loadHunter();
      });
      kwList.appendChild(chip);
    }

    const offersList = $('hunterOffersList');
    offersList.innerHTML = '';
    if (!data.offers || data.offers.length === 0) {
      offersList.innerHTML = '<p class="muted">Nenhuma oferta caçada ainda.</p>';
    } else {
      for (const off of data.offers) {
        const card = document.createElement('div');
        card.className = 'item-card';
        card.innerHTML = `
          <strong>${escapeHtml(off.title)}</strong>
          <div class="muted">${escapeHtml(off.price_text || '')} • Palavra: ${escapeHtml(off.source_ref || '')}</div>
          <div class="mono">${escapeHtml(off.affiliate_url)}</div>
        `;
        offersList.appendChild(card);
      }
    }
  }

  async function loadConverterHistory() {
    const data = await api('/api/converter/history');
    const container = $('converterHistoryList');
    container.innerHTML = '';
    if (!data.history || data.history.length === 0) {
      container.innerHTML = '<p class="muted">Nenhuma conversão registrada.</p>';
      return;
    }
    for (const item of data.history) {
      const card = document.createElement('div');
      card.className = 'item-card';
      card.innerHTML = `
        <strong>${escapeHtml(item.product_title || item.origin_url)}</strong>
        <div class="mono">${escapeHtml(item.affiliate_url)}</div>
        <div class="muted">Via: ${escapeHtml(item.requested_via)} • ${new Date(item.created_at).toLocaleString('pt-BR')}</div>
      `;
      container.appendChild(card);
    }
  }

  async function loadAllData() {
    await Promise.allSettled([
      api('/api/whatsapp/status').then((d) => renderWaStatus(d.whatsapp)),
      loadHealth(),
      loadShopee(),
      loadGroups(),
      loadHunter(),
      loadConverterHistory(),
    ]);
  }

  async function bootstrap() {
    try {
      const me = await api('/api/auth/me');
      if (me.user?.mustChangePassword) {
        showView('changePasswordView');
        return;
      }
      showView('appShell');
      startSse();
      await loadAllData();
    } catch (_) {
      showView('loginView');
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Eventos de Login e Troca de Senha
  $('loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('loginError').classList.add('hidden');
    try {
      const res = await api('/api/auth/login', {
        method: 'POST',
        body: {
          username: $('loginUsername').value.trim(),
          password: $('loginPassword').value,
        },
      });
      if (res.user?.mustChangePassword) {
        showView('changePasswordView');
      } else {
        showView('appShell');
        startSse();
        await loadAllData();
      }
    } catch (err) {
      $('loginError').textContent = err.message;
      $('loginError').classList.remove('hidden');
    }
  });

  $('changePasswordForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('changePasswordError').classList.add('hidden');
    const currentPassword = $('currentPasswordInput').value;
    const newPassword = $('newPasswordInput').value;
    const confirm = $('confirmNewPasswordInput').value;
    if (newPassword !== confirm) {
      $('changePasswordError').textContent = 'A confirmação da nova senha não confere.';
      $('changePasswordError').classList.remove('hidden');
      return;
    }
    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      });
      showToast('Senha alterada com sucesso.');
      showView('appShell');
      startSse();
      await loadAllData();
    } catch (err) {
      $('changePasswordError').textContent = err.message;
      $('changePasswordError').classList.remove('hidden');
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    if (sseSource) sseSource.close();
    await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    showView('loginView');
  });

  $('refreshAllBtn').addEventListener('click', () => loadAllData().then(() => showToast('Painel atualizado.')));

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });

  // Aba 1: WhatsApp
  $('waConnectBtn').addEventListener('click', async () => {
    try {
      const d = await api('/api/whatsapp/connect', { method: 'POST', body: {} });
      renderWaStatus(d.whatsapp);
      showToast('Conexão WhatsApp iniciada.');
    } catch (err) {
      showToast(err.message);
    }
  });

  $('waDisconnectBtn').addEventListener('click', async () => {
    try {
      const d = await api('/api/whatsapp/disconnect', { method: 'POST', body: {} });
      renderWaStatus(d.whatsapp);
      showToast('WhatsApp desconectado.');
    } catch (err) {
      showToast(err.message);
    }
  });

  $('waSwitchBtn').addEventListener('click', async () => {
    if (!window.confirm('Tem certeza que deseja limpar a sessão atual e conectar outro número?')) return;
    try {
      const d = await api('/api/whatsapp/switch-number', { method: 'POST', body: { confirm: true } });
      renderWaStatus(d.whatsapp);
      showToast('Sessão reiniciada. Aguarde o novo QR Code.');
    } catch (err) {
      showToast(err.message);
    }
  });

  // Aba 2: Shopee
  $('shopeeConfigForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('/api/shopee/config', {
        method: 'PUT',
        body: {
          appId: $('shopeeAppId').value.trim(),
          secretKey: $('shopeeSecretKey').value.trim(),
          defaultSubId: $('shopeeDefaultSubId').value.trim(),
        },
      });
      await loadShopee();
      showToast('Credenciais Shopee salvas com segurança.');
    } catch (err) {
      showToast(err.message);
    }
  });

  $('shopeeTestBtn').addEventListener('click', async () => {
    const box = $('shopeeTestResult');
    box.className = 'alert';
    box.textContent = 'Testando conexão na Open API Shopee Brasil...';
    box.classList.remove('hidden');
    try {
      const res = await api('/api/shopee/test', { method: 'POST', body: {} });
      box.className = 'alert alert-ok';
      box.textContent = `Conexão aprovada! Exemplo retornado: ${res.sampleTitle || 'OK'}`;
    } catch (err) {
      box.className = 'alert alert-error';
      box.textContent = err.message;
    }
    await loadShopee();
  });

  $('shopeeSearchForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const resBox = $('shopeeSearchResults');
    resBox.innerHTML = '<p class="muted">Consultando API Shopee...</p>';
    try {
      const data = await api('/api/shopee/search', {
        method: 'POST',
        body: { keyword: $('shopeeSearchKeyword').value.trim(), limit: 10 },
      });
      resBox.innerHTML = '';
      if (!data.offers || data.offers.length === 0) {
        resBox.innerHTML = '<p class="muted">Nenhum produto encontrado.</p>';
        return;
      }
      for (const o of data.offers) {
        const card = document.createElement('div');
        card.className = 'item-card';
        const comm = o.commissionRate ? `${(o.commissionRate * 100).toFixed(1)}%` : '—';
        card.innerHTML = `
          <strong>${escapeHtml(o.title)}</strong>
          <div class="muted">Preço: R$ ${Number(o.priceMin || 0).toFixed(2)} • Comissão: ${comm} • Vendas: ${o.sales ?? 0}</div>
          <div class="mono">${escapeHtml(o.offerLink || o.productUrl)}</div>
        `;
        resBox.appendChild(card);
      }
    } catch (err) {
      resBox.innerHTML = `<p class="alert alert-error">${escapeHtml(err.message)}</p>`;
    }
  });

  // Aba 3: Grupos
  $('syncGroupsBtn').addEventListener('click', async () => {
    try {
      await api('/api/groups/sync', { method: 'POST', body: {} });
      await loadGroups();
      showToast('Grupos sincronizados com o WhatsApp.');
    } catch (err) {
      showToast(err.message);
    }
  });

  $('mirrorConfigForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('/api/groups/mirror-config', {
        method: 'PUT',
        body: {
          enabled: $('mirrorEnabled').checked,
          privateConverterEnabled: $('privateConverterEnabled').checked,
          includeImage: $('mirrorIncludeImage').checked,
          dedupHours: Number($('mirrorDedupHours').value) || 12,
          subIdOverride: $('mirrorSubId').value.trim(),
        },
      });
      showToast('Regras de espelhamento salvas.');
    } catch (err) {
      showToast(err.message);
    }
  });

  // Aba 4: Caçador
  $('hunterConfigForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('/api/hunter/config', {
        method: 'PUT',
        body: {
          minCommissionPercent: Number($('hunterMinCommission').value) || 0,
          intervalMinutes: Number($('hunterIntervalMinutes').value) || 60,
          minPrice: Number($('hunterMinPrice').value) || 0,
          maxPrice: Number($('hunterMaxPrice').value) || 0,
          minSales: Number($('hunterMinSales').value) || 0,
          maxPerRun: Number($('hunterMaxPerRun').value) || 3,
          subId: $('hunterSubId').value.trim(),
        },
      });
      await loadHunter();
      showToast('Filtros do caçador salvos.');
    } catch (err) {
      showToast(err.message);
    }
  });

  $('hunterToggleBtn').addEventListener('click', async () => {
    try {
      await api('/api/hunter/toggle', { method: 'POST', body: { enabled: !currentHunterEnabled } });
      await loadHunter();
      showToast(!currentHunterEnabled ? 'Caçador ativado.' : 'Caçador pausado.');
    } catch (err) {
      showToast(err.message);
    }
  });

  $('hunterRunOnceBtn').addEventListener('click', async () => {
    try {
      const data = await api('/api/hunter/run-once', { method: 'POST', body: {} });
      await loadHunter();
      showToast(`Busca concluída: ${data.result?.offersSelected ?? 0} oferta(s) salva(s).`);
    } catch (err) {
      showToast(err.message);
    }
  });

  $('keywordForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('/api/hunter/keywords', {
        method: 'POST',
        body: { keyword: $('newKeywordInput').value.trim() },
      });
      $('newKeywordInput').value = '';
      await loadHunter();
    } catch (err) {
      showToast(err.message);
    }
  });

  // Aba 5: Conversor
  $('converterForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const data = await api('/api/converter/convert', {
        method: 'POST',
        body: {
          url: $('converterUrlInput').value.trim(),
          subId: $('converterSubIdInput').value.trim(),
        },
      });
      const r = data.result;
      $('convertedTitle').textContent = r.product?.title || 'Oferta Shopee';
      $('convertedLink').textContent = r.shortLink;
      $('convertedMessageBox').value = r.formattedMessage;
      if (r.product?.imageUrl) {
        $('convertedImage').src = r.product.imageUrl;
        $('convertedImage').classList.remove('hidden');
      } else {
        $('convertedImage').classList.add('hidden');
      }
      $('converterResultCard').classList.remove('hidden');
      await loadConverterHistory();
    } catch (err) {
      showToast(err.message);
    }
  });

  $('copyConvertedBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('convertedMessageBox').value);
      showToast('Mensagem copiada para a área de transferência.');
    } catch (_) {
      $('convertedMessageBox').select();
      showToast('Selecione e copie o texto acima.');
    }
  });

  bootstrap();
})();
