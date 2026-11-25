const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { groupDiagnostics } = require('../src/services/whatsapp/delivery_diagnostics');

test('diagnóstico correlaciona permissão de postagem, rejeição e recibos sem identificar membros', async () => {
  const records = [];
  const group = '1234567@g.us';
  const sock = {
    ev: new EventEmitter(), user: { id: '100:8@s.whatsapp.net' },
    groupMetadata: async () => ({ announce: true, participants: [{ id: '200@lid', phoneNumber: '100@s.whatsapp.net', admin: null }] })
  };
  const inspect = groupDiagnostics(sock, { info: (name, data) => records.push({ name, data }) });
  await inspect(group);
  const key = { id: 'exemplo', remoteJid: group, fromMe: true };
  sock.ev.emit('messages.update', [{ key, update: { status: 0, messageStubParameters: ['403'] } }]);
  for (let i = 0; i < 2; i++) sock.ev.emit('message-receipt.update', [{ key, receipt: { userJid: '300@lid', receiptTimestamp: 100 } }]);
  assert.equal(records.length, 3);
  assert.equal(records[0].data.somenteAdmins, true);
  assert.equal(records[0].data.admin, false);
  assert.equal(records[1].data.code, '403');
  assert.equal(records[2].name, '[WA-DIAG] recibo_dispositivo');
  assert.equal(records[1].data.ref, records[2].data.ref);
  assert.equal(records[0].data.group, records[1].data.group);
  assert.doesNotMatch(JSON.stringify(records), /exemplo|@/);
});
