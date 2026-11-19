// ==============================================================================
// Gerenciador de Grupos WhatsApp (Origem, Destino e Regras de Espelhamento)
// ==============================================================================

const { isValidGroupJid } = require('../whatsapp/engine');

const DEFAULT_MIRROR_CONFIG = {
  enabled: false,
  privateConverterEnabled: false,
  dedupHours: 12,
  includeImage: true,
  subIdOverride: '',
};

class GroupManager {
  constructor({ repository, whatsapp }) {
    this.repository = repository;
    this.whatsapp = whatsapp;
  }

  async syncGroupsFromWhatsApp() {
    const remoteGroups = await this.whatsapp.listGroups();
    return this.repository.syncWhatsAppGroups(remoteGroups);
  }

  async listGroups() {
    return this.repository.listWhatsAppGroups();
  }

  async updateGroup(jid, { isSource, isDestination, rules } = {}) {
    if (!isValidGroupJid(jid)) {
      throw new Error('JID de grupo WhatsApp inválido (esperado ...@g.us).');
    }
    const cleanRules = rules && typeof rules === 'object' ? {
      includeImage: rules.includeImage !== false,
      minPrice: Math.max(0, Number(rules.minPrice) || 0),
      maxPrice: Math.max(0, Number(rules.maxPrice) || 0),
      subId: typeof rules.subId === 'string' ? rules.subId.trim().slice(0, 64) : '',
      blockedWords: Array.isArray(rules.blockedWords)
        ? rules.blockedWords.map((w) => String(w || '').trim().toLowerCase()).filter(Boolean).slice(0, 30)
        : [],
    } : undefined;

    return this.repository.updateWhatsAppGroupConfig(jid, {
      isSource: typeof isSource === 'boolean' ? isSource : undefined,
      isDestination: typeof isDestination === 'boolean' ? isDestination : undefined,
      rules: cleanRules,
    });
  }

  async getMirrorConfig() {
    const saved = await this.repository.getSetting('mirror_config', null);
    return { ...DEFAULT_MIRROR_CONFIG, ...(saved || {}) };
  }

  async setMirrorConfig(patch = {}) {
    const current = await this.getMirrorConfig();
    const next = {
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
      privateConverterEnabled:
        typeof patch.privateConverterEnabled === 'boolean'
          ? patch.privateConverterEnabled
          : current.privateConverterEnabled,
      dedupHours: Math.max(1, Math.min(168, Number(patch.dedupHours ?? current.dedupHours) || 12)),
      includeImage: typeof patch.includeImage === 'boolean' ? patch.includeImage : current.includeImage,
      subIdOverride:
        typeof patch.subIdOverride === 'string' ? patch.subIdOverride.trim().slice(0, 64) : current.subIdOverride,
    };
    await this.repository.setSetting('mirror_config', next);
    return next;
  }

  async getSourceGroups() {
    const all = await this.listGroups();
    return all.filter((g) => g.is_source);
  }

  async getDestinationGroups() {
    const all = await this.listGroups();
    return all.filter((g) => g.is_destination);
  }
}

module.exports = { GroupManager, DEFAULT_MIRROR_CONFIG };
