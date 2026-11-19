// ==============================================================================
// Filtro de log: remove chaves de criptografia WhatsApp/Signal e segredos
// Adaptado do TITAN CRM para o ecossistema Shopee Afiliados (100% isolado)
// ==============================================================================

const OMITIDO = '[sessão de criptografia omitida]';
const SEGREDO_OMITIDO = '[segredo omitido]';
const MARCA = Symbol.for('shopeeAfiliados.filtroLogCriptografia');
const METODOS = ['log', 'info', 'warn', 'error', 'debug'];

const CHAVES_SESSAO = new Set([
  'baseKey', 'remoteIdentityKey', 'chainKey', 'rootKey', 'privKey', 'pubKey',
  'ephemeralKeyPair', 'indexInfo', 'currentRatchet', 'pendingPreKey',
  'registrationId', 'lastRemoteEphemeralKey', '_chains', 'messageKeys',
  'signedKeyId', 'preKeyId', 'noiseKey', 'signedIdentityKey', 'advSecretKey',
]);

const CLASSES_SESSAO = new Set(['SessionEntry', 'SessionRecord']);

const MENSAGENS_SILENCIADAS = new Set([
  'Closing session:',
  'Opening session:',
  'Removing old closed session:',
  'Migrating session to:',
  'Session already closed',
  'Session already open',
]);

const PROFUNDIDADE_MAX = 8;
const NOS_MAX = 2000;

const NOMES_REGEX = [...CHAVES_SESSAO]
  .filter((n) => n !== 'registrationId' && n !== 'messageKeys')
  .map((n) => n.replace(/[$]/g, '\\$&'))
  .join('|');
const DUMP_REGEX = new RegExp(`<SessionEntry|(?:^|[^A-Za-z0-9_])["']?(?:${NOMES_REGEX})["']?\\s*[:=]`);

// Padrões sensíveis de segredos e URLs de banco/cache com senha
const SECRET_KEY_NAMES = new Set([
  'secretKey', 'secret_key', 'shopeeSecretKey', 'SHOPEE_SECRET_KEY',
  'sessionEncryptionKey', 'SESSION_ENCRYPTION_KEY',
  'pingSecret', 'PING_SECRET', 'adminPasswordHash', 'ADMIN_PASSWORD_HASH',
  'password', 'newPassword', 'currentPassword', 'passwordHash',
  'databaseUrl', 'DATABASE_URL', 'redisUrl', 'REDIS_URL', 'authorization',
]);

function textoTemDump(texto) {
  try {
    return DUMP_REGEX.test(texto);
  } catch (_) {
    return false;
  }
}

function higienizarTextoSegredos(texto) {
  if (typeof texto !== 'string') return texto;
  if (textoTemDump(texto)) return OMITIDO;

  return texto
    .replace(/((?:postgres(?:ql)?|rediss?):\/\/[^:\s/]+:)([^@\s/]+)(@)/gi, '$1***$3')
    .replace(/(SHA256\s+Credential=[^,\s]+,\s*Timestamp=\d+,\s*Signature=)([a-f0-9]{16,})/gi, '$1***')
    .replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi, '$1***')
    .replace(/("(?:secretKey|secret_key|shopee_secret_key|session_encryption_key|ping_secret|password|admin_password_hash)"\s*:\s*")([^"]+)(")/gi, '$1***$3');
}

function nomeDaClasse(obj) {
  try {
    const c = obj.constructor;
    return c && typeof c.name === 'string' ? c.name : '';
  } catch (_) {
    return '';
  }
}

function ehBinario(obj) {
  return Buffer.isBuffer(obj) || ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer;
}

function analisarObjeto(raiz) {
  const visitados = new WeakSet();
  const pilha = [[raiz, 0]];
  let nos = 0;
  try {
    while (pilha.length) {
      const [atual, profundidade] = pilha.pop();
      if (atual === null || (typeof atual !== 'object' && typeof atual !== 'function')) continue;
      if (visitados.has(atual)) continue;
      visitados.add(atual);
      if (ehBinario(atual)) continue;
      if (++nos > NOS_MAX) break;
      if (CLASSES_SESSAO.has(nomeDaClasse(atual))) return 'sessao';
      if (typeof atual === 'function' && profundidade > 0) continue;

      if (atual instanceof Map) {
        for (const [k, v] of atual) {
          if (typeof k === 'string' && CHAVES_SESSAO.has(k)) return 'sessao';
          if (profundidade < PROFUNDIDADE_MAX) pilha.push([v, profundidade + 1]);
        }
        continue;
      }
      if (atual instanceof Set) {
        if (profundidade < PROFUNDIDADE_MAX) {
          for (const v of atual) pilha.push([v, profundidade + 1]);
        }
        continue;
      }

      const nomes = Object.keys(atual);
      for (const nome of nomes) {
        if (CHAVES_SESSAO.has(nome)) return 'sessao';
      }
      if (profundidade >= PROFUNDIDADE_MAX) continue;
      for (const nome of nomes) {
        const valor = atual[nome];
        if (typeof valor === 'string') {
          if (valor.length > 20 && textoTemDump(valor)) return 'sessao';
        } else if (valor !== null && typeof valor === 'object') {
          pilha.push([valor, profundidade + 1]);
        }
      }
    }
    return 'limpo';
  } catch (_) {
    return 'falhou';
  }
}

function pareceSessao(obj) {
  try {
    if (CLASSES_SESSAO.has(nomeDaClasse(obj))) return true;
    for (const nome of Reflect.ownKeys(obj)) {
      if (typeof nome === 'string' && CHAVES_SESSAO.has(nome)) return true;
    }
  } catch (_) {}
  return false;
}

function mascararObjeto(obj, profundidade = 0, visitados = new WeakSet()) {
  if (!obj || typeof obj !== 'object' || ehBinario(obj) || profundidade > 5) return obj;
  if (obj instanceof Error) {
    return higienizarTextoSegredos(obj.stack || obj.message || String(obj));
  }
  if (visitados.has(obj)) return '[Circular]';
  visitados.add(obj);

  if (Array.isArray(obj)) {
    return obj.map((item) => (typeof item === 'string' ? higienizarTextoSegredos(item) : mascararObjeto(item, profundidade + 1, visitados)));
  }

  const copia = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_KEY_NAMES.has(k)) {
      copia[k] = SEGREDO_OMITIDO;
    } else if (typeof v === 'string') {
      copia[k] = higienizarTextoSegredos(v);
    } else if (v && typeof v === 'object') {
      copia[k] = mascararObjeto(v, profundidade + 1, visitados);
    } else {
      copia[k] = v;
    }
  }
  return copia;
}

function higienizarArgumento(arg) {
  if (typeof arg === 'string') return higienizarTextoSegredos(arg);
  if (arg === null || (typeof arg !== 'object' && typeof arg !== 'function')) return arg;
  const resultado = analisarObjeto(arg);
  if (resultado === 'sessao') return OMITIDO;
  if (resultado === 'falhou') return pareceSessao(arg) ? OMITIDO : arg;
  return mascararObjeto(arg);
}

function higienizarArgumentos(args) {
  const lista = Array.isArray(args) ? args : [];
  const saida = new Array(lista.length);
  for (let i = 0; i < lista.length; i++) {
    try {
      saida[i] = higienizarArgumento(lista[i]);
    } catch (_) {
      saida[i] = lista[i];
    }
  }
  return saida;
}

function deveSilenciar(args) {
  return args.length > 0 && typeof args[0] === 'string' && MENSAGENS_SILENCIADAS.has(args[0]);
}

function instalarFiltroLogCriptografia(consoleAlvo = console) {
  if (!consoleAlvo) return consoleAlvo;
  for (const metodo of METODOS) {
    const original = consoleAlvo[metodo];
    if (typeof original !== 'function' || original[MARCA]) continue;
    const embrulhado = function filtroLogCriptografia(...args) {
      let final = args;
      try {
        if (deveSilenciar(args)) return undefined;
        final = higienizarArgumentos(args);
      } catch (_) {
        final = args;
      }
      return original.apply(this, final);
    };
    Object.defineProperty(embrulhado, MARCA, { value: true });
    consoleAlvo[metodo] = embrulhado;
  }
  return consoleAlvo;
}

module.exports = {
  instalarFiltroLogCriptografia,
  higienizarArgumentos,
  higienizarTextoSegredos,
  OMITIDO,
  SEGREDO_OMITIDO,
  MENSAGENS_SILENCIADAS,
  CHAVES_SESSAO,
};
