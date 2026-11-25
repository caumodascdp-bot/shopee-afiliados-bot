const { createHash } = require('node:crypto');

function reference(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function groupDiagnostics(sock, log, repository) {
  const received = new Set();
  const checked = new Set();

  function report(key, event, code) {
    if (!key?.fromMe || !key.remoteJid?.endsWith('@g.us') || !key.id) return;
    const ref = reference(key.id);
    const signature = [key.remoteJid, ref, event, code].join('/');
    if (received.has(signature)) return;
    if (repository) {
      const reason = event === 'rejeitada' ? 'WhatsApp recusou a mensagem (' + code + ')' : '';
      repository.recordWhatsAppReceipt(key.remoteJid, key.id, reason).catch(err => {
        received.delete(signature);
        log.warn('[WA-DIAG] Erro ao registrar recibo', { ref, error: err.message });
      });
    }
    received.add(signature);
    if (received.size > 2000) received.delete(received.values().next().value);
    log.info('[WA-DIAG] ' + event, { group: reference(key.remoteJid), ref, code });
  }

  sock.ev.on('messages.update', updates => {
    for (const { key, update } of updates) {
      if (update.status === 0) {
        const raw = String(update.messageStubParameters?.[0] ?? '');
        report(key, 'rejeitada', /^\d{1,5}$/.test(raw) ? raw : 'desconhecido');
      }
    }
  });
  sock.ev.on('message-receipt.update', updates => {
    for (const { key, receipt } of updates) {
      const normalize = id => id?.replace(/:\d+@/, '@');
      const own = [sock.user?.id, sock.user?.lid].filter(Boolean).map(normalize);
      if (receipt.userJid && own.includes(normalize(receipt.userJid))) continue;
      // Baileys também usa readTimestamp para recibos do tipo sender (SERVER_ACK).
      if (receipt.userJid && Number(receipt.receiptTimestamp) > 0) report(key, 'recibo_dispositivo');
    }
  });

  return async function inspect(jid) {
    if (!jid.endsWith('@g.us') || checked.has(jid)) return;
    checked.add(jid);
    const group = reference(jid);
    try {
      const meta = await sock.groupMetadata(jid);
      const normalize = id => id?.replace(/:\d+@/, '@');
      const own = [sock.user?.id, sock.user?.lid].filter(Boolean).map(normalize);
      const me = meta.participants.find(p =>
        [p.id, p.lid, p.phoneNumber].some(id => own.includes(normalize(id)))
      );
      log.info('[WA-DIAG] permissao_grupo', {
        group, somenteAdmins: meta.announce, contaLocalizada: Boolean(me),
        admin: me ? ['admin', 'superadmin'].includes(me.admin) : null
      });
    } catch {
      checked.delete(jid);
      log.warn('[WA-DIAG] metadados_indisponiveis', { group });
    }
  };
}

module.exports = { groupDiagnostics };
