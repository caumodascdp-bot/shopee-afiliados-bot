// ==============================================================================
// Normalizador de mensagens Baileys (MessageNormalizer)
// Adaptado do módulo homônimo do TITAN CRM para o Shopee Afiliados (100% isolado)
// ==============================================================================

const EMBRULHOS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'documentWithCaptionMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'editedMessage',
  'associatedChildMessage',
  'groupStatusMessage',
  'groupStatusMessageV2',
];

let baileysUtils;
function utilsDaBaileys() {
  if (baileysUtils !== undefined) return baileysUtils;
  try {
    const b = require('@whiskeysockets/baileys');
    baileysUtils =
      typeof b.normalizeMessageContent === 'function' && typeof b.getContentType === 'function'
        ? { normalizeMessageContent: b.normalizeMessageContent, getContentType: b.getContentType }
        : null;
  } catch (_) {
    baileysUtils = null;
  }
  return baileysUtils;
}

function abrirEmbrulhosManual(content) {
  let atual = content;
  for (let i = 0; i < 5; i++) {
    if (!atual || typeof atual !== 'object') break;
    const chave = EMBRULHOS.find((k) => atual[k] && typeof atual[k] === 'object');
    if (!chave || !atual[chave].message) break;
    atual = atual[chave].message;
  }
  return atual;
}

function tipoDoConteudoManual(content) {
  if (!content || typeof content !== 'object') return undefined;
  return Object.keys(content).find(
    (k) => (k === 'conversation' || k.includes('Message')) && k !== 'senderKeyDistributionMessage'
  );
}

class MessageNormalizer {
  static unwrap(raw, opcoes = {}) {
    if (!raw || typeof raw !== 'object') return raw;
    const utils = opcoes.semBaileys ? null : utilsDaBaileys();
    if (utils) {
      try {
        const aberto = utils.normalizeMessageContent(raw);
        if (aberto && typeof aberto === 'object') return aberto;
      } catch (_) {}
    }
    return abrirEmbrulhosManual(raw) || raw;
  }

  static contentType(raw, opcoes = {}) {
    const aberto = MessageNormalizer.unwrap(raw, opcoes);
    if (!aberto || typeof aberto !== 'object') return undefined;
    const utils = opcoes.semBaileys ? null : utilsDaBaileys();
    if (utils) {
      try {
        const t = utils.getContentType(aberto);
        if (t) return t;
      } catch (_) {}
    }
    return tipoDoConteudoManual(aberto);
  }

  static extractText(rawMessage) {
    if (!rawMessage || typeof rawMessage !== 'object') return '';
    const unwrapped = MessageNormalizer.unwrap(rawMessage) || {};

    const editada = unwrapped.protocolMessage?.editedMessage;
    if (editada && typeof editada === 'object') {
      const conteudo = editada.message && typeof editada.message === 'object' ? editada.message : editada;
      return MessageNormalizer.extractText(conteudo);
    }

    if (typeof unwrapped.conversation === 'string') return unwrapped.conversation.trim();
    if (typeof unwrapped.extendedTextMessage?.text === 'string') return unwrapped.extendedTextMessage.text.trim();
    if (typeof unwrapped.imageMessage?.caption === 'string' && unwrapped.imageMessage.caption.trim()) {
      return unwrapped.imageMessage.caption.trim();
    }
    if (typeof unwrapped.videoMessage?.caption === 'string' && unwrapped.videoMessage.caption.trim()) {
      return unwrapped.videoMessage.caption.trim();
    }
    if (typeof unwrapped.documentMessage?.caption === 'string' && unwrapped.documentMessage.caption.trim()) {
      return unwrapped.documentMessage.caption.trim();
    }
    return '';
  }

  static detectCanonicalType(rawMessage) {
    if (!rawMessage || typeof rawMessage !== 'object') return 'text';
    const unwrapped = MessageNormalizer.unwrap(rawMessage) || {};
    if (unwrapped.conversation || unwrapped.extendedTextMessage) return 'text';
    if (unwrapped.imageMessage) return 'image';
    if (unwrapped.videoMessage) return 'video';
    if (unwrapped.documentMessage) return 'document';
    if (unwrapped.audioMessage) return 'audio';
    if (unwrapped.stickerMessage) return 'sticker';
    if (unwrapped.protocolMessage) return 'protocol';
    return 'text';
  }
}

module.exports = MessageNormalizer;
