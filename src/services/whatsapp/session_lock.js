// ==============================================================================
// Trava distribuída de dono da sessão WhatsApp (evita colisão 440 / multi-instância)
// Adaptada de src/whatsapp/trava_sessao.js do TITAN CRM
// ==============================================================================

const os = require('os');
const fs = require('fs');

const LOCK_TTL_SECONDS = 120;
const RENEW_INTERVAL_MS = 30000;
const RETRY_MARGIN_MS = 5000;

function readFirstLine(paths) {
  for (const p of paths) {
    try {
      const val = fs.readFileSync(p, 'utf8').trim();
      if (val) return val;
    } catch (_) {}
  }
  return null;
}

const MACHINE_ID_FILE = readFirstLine(['/etc/machine-id', '/var/lib/dbus/machine-id']);
const BOOT_ID = readFirstLine(['/proc/sys/kernel/random/boot_id']);

function createOwnerIdentity(nodeName = process.env.RENDER_INSTANCE_ID || process.env.MACHINE_ID || 'shopee-node') {
  const info = {
    node: String(nodeName),
    pid: process.pid,
    machine: MACHINE_ID_FILE,
    host: os.hostname(),
    boot: BOOT_ID,
  };
  return { ...info, serialized: JSON.stringify(info) };
}

function parseOwner(raw) {
  if (!raw) return null;
  try {
    const d = JSON.parse(String(raw));
    if (d && typeof d === 'object') {
      return {
        node: d.node || null,
        pid: Number(d.pid),
        machine: d.machine || null,
        host: d.host || null,
        boot: d.boot || null,
      };
    }
  } catch (_) {}
  return null;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !(e && e.code === 'ESRCH');
  }
}

function evaluateLock(currentRaw, me, { checkPidAlive = isPidAlive } = {}) {
  if (!currentRaw) return { action: 'take', reason: 'livre' };
  if (currentRaw === me.serialized) return { action: 'take', reason: 'minha' };

  const owner = parseOwner(currentRaw);
  if (!owner || !owner.machine || !me.machine) {
    return { action: 'respect', reason: 'outro processo ou sem identidade da máquina' };
  }
  if (owner.node !== me.node || owner.machine !== me.machine) {
    return { action: 'respect', reason: 'outra máquina/instância' };
  }
  if (owner.boot && me.boot && owner.boot !== me.boot) {
    return { action: 'take', reason: 'trava de boot anterior' };
  }
  if (owner.pid === me.pid) {
    return { action: 'take', reason: 'mesmo processo' };
  }
  if (!checkPidAlive(owner.pid)) {
    return { action: 'take', reason: 'processo antigo encerrado' };
  }
  return { action: 'respect', reason: 'processo vivo' };
}

function lockKey(sessionId) {
  return `lock:session_owner:${sessionId}`;
}

async function acquireSessionLock(redis, sessionId, { me = createOwnerIdentity(), checkPidAlive = isPidAlive } = {}) {
  if (!redis) return { ok: true, reason: 'sem redis', previousOwner: null, retryAfterMs: 0 };
  const key = lockKey(sessionId);

  for (let round = 0; round < 2; round++) {
    const current = await redis.get(key);
    const decision = evaluateLock(current, me, { checkPidAlive });

    if (decision.action === 'respect') {
      const ttl = await redis.ttl(key);
      const sec = ttl > 0 ? ttl : LOCK_TTL_SECONDS;
      return {
        ok: false,
        reason: decision.reason,
        previousOwner: current,
        retryAfterMs: sec * 1000 + RETRY_MARGIN_MS,
      };
    }

    if (!current) {
      if (await redis.setIfAbsent(key, me.serialized, LOCK_TTL_SECONDS)) {
        return { ok: true, reason: 'livre', previousOwner: null, retryAfterMs: 0 };
      }
      continue;
    }

    if (await redis.replaceIfEquals(key, current, me.serialized, LOCK_TTL_SECONDS)) {
      return { ok: true, reason: decision.reason, previousOwner: current, retryAfterMs: 0 };
    }
  }

  return {
    ok: false,
    reason: 'disputa pela trava',
    previousOwner: null,
    retryAfterMs: LOCK_TTL_SECONDS * 1000 + RETRY_MARGIN_MS,
  };
}

async function renewSessionLock(redis, sessionId, me = createOwnerIdentity()) {
  if (!redis) return false;
  const key = lockKey(sessionId);
  if (await redis.replaceIfEquals(key, me.serialized, me.serialized, LOCK_TTL_SECONDS)) {
    return true;
  }
  return redis.setIfAbsent(key, me.serialized, LOCK_TTL_SECONDS);
}

async function releaseSessionLock(redis, sessionId, me = createOwnerIdentity()) {
  if (!redis) return false;
  return redis.deleteIfEquals(lockKey(sessionId), me.serialized);
}

module.exports = {
  LOCK_TTL_SECONDS,
  RENEW_INTERVAL_MS,
  lockKey,
  createOwnerIdentity,
  evaluateLock,
  acquireSessionLock,
  renewSessionLock,
  releaseSessionLock,
};
