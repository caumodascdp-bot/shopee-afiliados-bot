const test = require('node:test');
const assert = require('node:assert/strict');
const { HunterScheduler } = require('../src/jobs/scheduler');

test('agendador limita tentativas após erro e retoma após sucesso', async () => {
  let attempts = 0;
  const scheduler = new HunterScheduler({ hunter: {
    getConfig: async () => ({ enabled: true }),
    runCycle: async () => { if (++attempts === 1) throw new Error('temporário'); return { ok: true }; },
  } });
  scheduler.start();
  try {
    await assert.rejects(scheduler.tick(), /temporário/);
    assert.equal((await scheduler.tick()).reason, 'retry_backoff');
    assert.equal(attempts, 1);
    scheduler._retryAt = 0;
    assert.equal((await scheduler.tick()).ok, true);
    assert.equal(scheduler._failures, 0);
  } finally { scheduler.stop(); }
});

test('agendador impede ciclos sobrepostos', async () => {
  let finish;
  const scheduler = new HunterScheduler({ hunter: {
    getConfig: async () => ({ enabled: true }),
    runCycle: () => new Promise(resolve => { finish = resolve; }),
  } });
  scheduler.start();
  try {
    const first = scheduler.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await scheduler.tick()).reason, 'in_flight');
    finish({ ok: true });
    assert.equal((await first).ok, true);
  } finally { scheduler.stop(); }
});
