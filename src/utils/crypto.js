// ==============================================================================
// Criptografia em repouso (AES-256-GCM), hash de senha (scrypt) e tokens HMAC
// ==============================================================================

const crypto = require('crypto');

let ephemeralFallbackKey = null;

function getEphemeralFallbackKey() {
  if (!ephemeralFallbackKey) {
    ephemeralFallbackKey = crypto.randomBytes(32);
  }
  return ephemeralFallbackKey;
}

function resolveEncryptionKeyBytes(rawKey, { isProduction = false } = {}) {
  const normalized = String(rawKey || '').trim();
  if (!normalized) {
    if (isProduction) {
      throw new Error('SESSION_ENCRYPTION_KEY obrigatória em produção.');
    }
    return getEphemeralFallbackKey();
  }
  if (normalized.length < 16) {
    throw new Error('SESSION_ENCRYPTION_KEY deve ter ao menos 16 caracteres.');
  }
  // Deriva chave fixa de 32 bytes com SHA-256 + salt de contexto de domínio
  return crypto.createHash('sha256').update(`shopee-afiliados:enc:${normalized}`, 'utf8').digest();
}

function encryptJson(data, rawKey, aad = 'default', opts = {}) {
  const key = resolveEncryptionKeyBytes(rawKey, opts);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptJson(payload, rawKey, aad = 'default', opts = {}) {
  if (typeof payload !== 'string' || !payload.startsWith('v1:')) {
    throw new Error('Formato de payload criptografado inválido.');
  }
  const parts = payload.split(':');
  if (parts.length !== 4) {
    throw new Error('Payload criptografado corrompido.');
  }
  const key = resolveEncryptionKeyBytes(rawKey, opts);
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ciphertext = Buffer.from(parts[3], 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(String(aad), 'utf8'));
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

function hashPassword(plainPassword) {
  if (typeof plainPassword !== 'string' || plainPassword.length < 6) {
    throw new Error('Senha deve conter pelo menos 6 caracteres.');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(plainPassword, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(plainPassword, storedHash) {
  if (typeof plainPassword !== 'string' || typeof storedHash !== 'string') return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;
  try {
    const derived = crypto.scryptSync(plainPassword, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch (_) {
    return false;
  }
}

function signAuthToken(payload, secretKey, ttlSeconds = 12 * 3600) {
  const key = resolveEncryptionKeyBytes(secretKey, { isProduction: false });
  const nowSec = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    iat: nowSec,
    exp: nowSec + ttlSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyAuthToken(token, secretKey) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;
  const key = resolveEncryptionKeyBytes(secretKey, { isProduction: false });
  const expectedSig = crypto.createHmac('sha256', key).update(encoded).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!data || typeof data.exp !== 'number' || data.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return data;
  } catch (_) {
    return null;
  }
}

function maskSecret(secret) {
  const s = String(secret || '').trim();
  if (!s) return '';
  if (s.length <= 6) return '******';
  return `${s.slice(0, 2)}${'*'.repeat(Math.min(12, s.length - 4))}${s.slice(-2)}`;
}

function timingSafeCompareText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function generateRandomSecret(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64url');
}

module.exports = {
  encryptJson,
  decryptJson,
  hashPassword,
  verifyPassword,
  signAuthToken,
  verifyAuthToken,
  maskSecret,
  timingSafeCompareText,
  generateRandomSecret,
};
