// ==============================================================================
// Repositório Relacional Único (Neon PostgreSQL + Fallback em Memória para Testes)
// ==============================================================================

class Repository {
  constructor({ pgClient = null } = {}) {
    this.pg = pgClient;
    this._memory = {
      adminUsers: new Map(),
      settings: new Map(),
      shopeeCredentials: {
        id: 1,
        app_id: '',
        secret_key_encrypted: '',
        default_sub_id: 'whatsapp_grupos',
        sub_ids_json: [],
        last_tested_at: null,
        last_test_status: 'untested',
        last_test_error: '',
        updated_at: new Date().toISOString(),
      },
      groups: new Map(),
      keywords: [],
      products: [],
      offers: [],
      conversions: [],
      queueJobs: [],
      publications: [],
      auditLogs: [],
      baileysAuth: new Map(),
      seq: { user: 1, keyword: 1, product: 1, offer: 1, conversion: 1, job: 1, pub: 1, audit: 1 },
    };
  }

  usePg() {
    return Boolean(this.pg && this.pg.isPostgresActive());
  }

  // ---------------- USUÁRIOS ADMIN ----------------
  async getAdminByUsername(username = 'admin') {
    if (this.usePg()) {
      const res = await this.pg.query('SELECT * FROM admin_users WHERE username = $1 LIMIT 1', [username]);
      return res.rows[0] || null;
    }
    return this._memory.adminUsers.get(username) || null;
  }

  async upsertAdminUser({ username = 'admin', passwordHash, mustChangePassword = false }) {
    if (this.usePg()) {
      const res = await this.pg.query(
        `INSERT INTO admin_users (username, password_hash, must_change_password)
         VALUES ($1, $2, $3)
         ON CONFLICT (username) DO UPDATE
           SET password_hash = EXCLUDED.password_hash,
               must_change_password = EXCLUDED.must_change_password,
               updated_at = NOW()
         RETURNING *`,
        [username, passwordHash, Boolean(mustChangePassword)]
      );
      return res.rows[0];
    }
    const existing = this._memory.adminUsers.get(username);
    const now = new Date().toISOString();
    const record = {
      id: existing ? existing.id : this._memory.seq.user++,
      username,
      password_hash: passwordHash,
      must_change_password: Boolean(mustChangePassword),
      created_at: existing ? existing.created_at : now,
      updated_at: now,
    };
    this._memory.adminUsers.set(username, record);
    return { ...record };
  }

  // ---------------- CONFIGURAÇÕES GERAIS ----------------
  async getSetting(key, defaultValue = null) {
    if (this.usePg()) {
      const res = await this.pg.query('SELECT value_json FROM app_settings WHERE key = $1 LIMIT 1', [key]);
      return res.rows[0] ? res.rows[0].value_json : defaultValue;
    }
    return this._memory.settings.has(key) ? this._memory.settings.get(key) : defaultValue;
  }

  async setSetting(key, value) {
    if (this.usePg()) {
      await this.pg.query(
        `INSERT INTO app_settings (key, value_json)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE
           SET value_json = EXCLUDED.value_json,
               updated_at = NOW()`,
        [key, JSON.stringify(value ?? {})]
      );
      return value;
    }
    this._memory.settings.set(key, structuredClone(value ?? {}));
    return value;
  }

  // ---------------- CREDENCIAIS SHOPEE ----------------
  async getShopeeCredentials() {
    if (this.usePg()) {
      const res = await this.pg.query('SELECT * FROM shopee_credentials WHERE id = 1 LIMIT 1');
      return res.rows[0] || null;
    }
    return { ...this._memory.shopeeCredentials };
  }

  async saveShopeeCredentials({ appId, secretKeyEncrypted, defaultSubId, subIds = [] }) {
    if (this.usePg()) {
      const res = await this.pg.query(
        `INSERT INTO shopee_credentials (id, app_id, secret_key_encrypted, default_sub_id, sub_ids_json)
         VALUES (1, $1, $2, $3, $4::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           app_id = EXCLUDED.app_id,
           secret_key_encrypted = CASE
             WHEN EXCLUDED.secret_key_encrypted <> '' THEN EXCLUDED.secret_key_encrypted
             ELSE shopee_credentials.secret_key_encrypted
           END,
           default_sub_id = EXCLUDED.default_sub_id,
           sub_ids_json = EXCLUDED.sub_ids_json,
           updated_at = NOW()
         RETURNING *`,
        [appId || '', secretKeyEncrypted || '', defaultSubId || 'whatsapp_grupos', JSON.stringify(subIds || [])]
      );
      return res.rows[0];
    }
    const cur = this._memory.shopeeCredentials;
    cur.app_id = appId || '';
    if (secretKeyEncrypted) cur.secret_key_encrypted = secretKeyEncrypted;
    cur.default_sub_id = defaultSubId || 'whatsapp_grupos';
    cur.sub_ids_json = Array.isArray(subIds) ? [...subIds] : [];
    cur.updated_at = new Date().toISOString();
    return { ...cur };
  }

  async updateShopeeTestStatus({ status, error = '' }) {
    if (this.usePg()) {
      await this.pg.query(
        `INSERT INTO shopee_credentials (id, last_tested_at, last_test_status, last_test_error)
         VALUES (1, NOW(), $1, $2)
         ON CONFLICT (id) DO UPDATE SET
           last_tested_at = NOW(),
           last_test_status = EXCLUDED.last_test_status,
           last_test_error = EXCLUDED.last_test_error,
           updated_at = NOW()`,
        [status, error || '']
      );
      return;
    }
    this._memory.shopeeCredentials.last_tested_at = new Date().toISOString();
    this._memory.shopeeCredentials.last_test_status = status;
    this._memory.shopeeCredentials.last_test_error = error || '';
  }

  // ---------------- GRUPOS WHATSAPP ----------------
  async syncWhatsAppGroups(groups = []) {
    if (this.usePg()) {
      return this.pg.withTransaction(async (client) => {
        for (const g of groups) {
          await client.query(
            `INSERT INTO whatsapp_groups (jid, name, participants_count, last_seen_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (jid) DO UPDATE SET
               name = EXCLUDED.name,
               participants_count = EXCLUDED.participants_count,
               last_seen_at = NOW(),
               updated_at = NOW()`,
            [g.jid, g.name || g.jid, Number(g.participantsCount) || 0]
          );
        }
        const res = await client.query('SELECT * FROM whatsapp_groups ORDER BY name ASC');
        return res.rows;
      });
    }
    const now = new Date().toISOString();
    for (const g of groups) {
      const existing = this._memory.groups.get(g.jid);
      this._memory.groups.set(g.jid, {
        jid: g.jid,
        name: g.name || g.jid,
        participants_count: Number(g.participantsCount) || 0,
        is_source: existing ? existing.is_source : false,
        is_destination: existing ? existing.is_destination : false,
        rules_json: existing ? existing.rules_json : {},
        last_seen_at: now,
        updated_at: now,
      });
    }
    return this.listWhatsAppGroups();
  }

  async listWhatsAppGroups() {
    if (this.usePg()) {
      const res = await this.pg.query('SELECT * FROM whatsapp_groups ORDER BY name ASC, jid ASC');
      return res.rows;
    }
    return [...this._memory.groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async updateWhatsAppGroupConfig(jid, { name, isSource, isDestination, rules } = {}) {
    if (this.usePg()) {
      const res = await this.pg.query(
        `INSERT INTO whatsapp_groups (jid, name, is_source, is_destination, rules_json)
         VALUES ($1, COALESCE($2, $1), COALESCE($3, FALSE), COALESCE($4, FALSE), COALESCE($5::jsonb, '{}'::jsonb))
         ON CONFLICT (jid) DO UPDATE SET
           name = COALESCE($2, whatsapp_groups.name),
           is_source = COALESCE($3, whatsapp_groups.is_source),
           is_destination = COALESCE($4, whatsapp_groups.is_destination),
           rules_json = COALESCE($5::jsonb, whatsapp_groups.rules_json),
           updated_at = NOW()
         RETURNING *`,
        [
          jid,
          name ?? null,
          typeof isSource === 'boolean' ? isSource : null,
          typeof isDestination === 'boolean' ? isDestination : null,
          rules ? JSON.stringify(rules) : null,
        ]
      );
      return res.rows[0];
    }
    const existing = this._memory.groups.get(jid) || {
      jid,
      name: name || jid,
      participants_count: 0,
      is_source: false,
      is_destination: false,
      rules_json: {},
      last_seen_at: new Date().toISOString(),
    };
    const updated = {
      ...existing,
      name: name ?? existing.name,
      is_source: typeof isSource === 'boolean' ? isSource : existing.is_source,
      is_destination: typeof isDestination === 'boolean' ? isDestination : existing.is_destination,
      rules_json: rules ? { ...rules } : existing.rules_json,
      updated_at: new Date().toISOString(),
    };
    this._memory.groups.set(jid, updated);
    return { ...updated };
  }

  // ---------------- PALAVRAS-CHAVE DO CAÇADOR ----------------
  async listHunterKeywords() {
    if (this.usePg()) {
      const res = await this.pg.query('SELECT * FROM hunter_keywords ORDER BY id DESC');
      return res.rows;
    }
    return [...this._memory.keywords].sort((a, b) => b.id - a.id);
  }

  async addHunterKeyword({ keyword, minCommissionRate = 0, minPrice = 0, maxPrice = 0, minSales = 0, active = true }) {
    const clean = String(keyword || '').trim();
    if (!clean) throw new Error('Palavra-chave obrigatória.');
    if (this.usePg()) {
      const res = await this.pg.query(
        `INSERT INTO hunter_keywords (keyword, min_commission_rate, min_price, max_price, min_sales, active)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (keyword) DO UPDATE SET
           min_commission_rate = EXCLUDED.min_commission_rate,
           min_price = EXCLUDED.min_price,
           max_price = EXCLUDED.max_price,
           min_sales = EXCLUDED.min_sales,
           active = EXCLUDED.active,
           updated_at = NOW()
         RETURNING *`,
        [clean, Number(minCommissionRate) || 0, Number(minPrice) || 0, Number(maxPrice) || 0, Number(minSales) || 0, Boolean(active)]
      );
      return res.rows[0];
    }
    const now = new Date().toISOString();
    const existing = this._memory.keywords.find((k) => k.keyword.toLowerCase() === clean.toLowerCase());
    if (existing) {
      Object.assign(existing, {
        keyword: clean,
        min_commission_rate: Number(minCommissionRate) || 0,
        min_price: Number(minPrice) || 0,
        max_price: Number(maxPrice) || 0,
        min_sales: Number(minSales) || 0,
        active: Boolean(active),
        updated_at: now,
      });
      return { ...existing };
    }
    const rec = {
      id: this._memory.seq.keyword++,
      keyword: clean,
      min_commission_rate: Number(minCommissionRate) || 0,
      min_price: Number(minPrice) || 0,
      max_price: Number(maxPrice) || 0,
      min_sales: Number(minSales) || 0,
      active: Boolean(active),
      created_at: now,
      updated_at: now,
    };
    this._memory.keywords.push(rec);
    return { ...rec };
  }

  async deleteHunterKeyword(id) {
    const numId = Number(id);
    if (this.usePg()) {
      const res = await this.pg.query('DELETE FROM hunter_keywords WHERE id = $1 RETURNING id', [numId]);
      return res.rowCount > 0;
    }
    const before = this._memory.keywords.length;
    this._memory.keywords = this._memory.keywords.filter((k) => k.id !== numId);
    return this._memory.keywords.length < before;
  }

  // ---------------- PRODUTOS, OFERTAS E CONVERSÕES ----------------
  async upsertProduct(p) {
    if (this.usePg()) {
      const res = await this.pg.query(
        `INSERT INTO products (
           item_id, shop_id, title, shop_name, price_min, price_max,
           discount_percent, commission_rate, commission_estimated, sales,
           rating, product_url, affiliate_url, image_url, metadata_json, last_seen_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,NOW())
         ON CONFLICT (item_id, shop_id) DO UPDATE SET
           title = EXCLUDED.title,
           shop_name = EXCLUDED.shop_name,
           price_min = EXCLUDED.price_min,
           price_max = EXCLUDED.price_max,
           discount_percent = EXCLUDED.discount_percent,
           commission_rate = EXCLUDED.commission_rate,
           commission_estimated = EXCLUDED.commission_estimated,
           sales = EXCLUDED.sales,
           rating = EXCLUDED.rating,
           product_url = EXCLUDED.product_url,
           affiliate_url = CASE WHEN EXCLUDED.affiliate_url <> '' THEN EXCLUDED.affiliate_url ELSE products.affiliate_url END,
           image_url = COALESCE(NULLIF(EXCLUDED.image_url, ''), products.image_url),
           metadata_json = EXCLUDED.metadata_json,
           last_seen_at = NOW()
         RETURNING *`,
        [
          String(p.itemId),
          String(p.shopId || ''),
          p.title,
          p.shopName || '',
          Number(p.priceMin) || 0,
          Number(p.priceMax) || 0,
          p.discountPercent ?? null,
          p.commissionRate ?? null,
          p.commissionEstimated ?? null,
          p.sales ?? null,
          p.rating ?? null,
          p.productUrl,
          p.affiliateUrl || '',
          p.imageUrl || '',
          JSON.stringify(p.metadata || {}),
        ]
      );
      return res.rows[0];
    }
    const now = new Date().toISOString();
    let rec = this._memory.products.find(
      (x) => x.item_id === String(p.itemId) && x.shop_id === String(p.shopId || '')
    );
    if (!rec) {
      rec = {
        id: this._memory.seq.product++,
        item_id: String(p.itemId),
        shop_id: String(p.shopId || ''),
        first_seen_at: now,
      };
      this._memory.products.push(rec);
    }
    Object.assign(rec, {
      title: p.title,
      shop_name: p.shopName || '',
      price_min: Number(p.priceMin) || 0,
      price_max: Number(p.priceMax) || 0,
      discount_percent: p.discountPercent ?? null,
      commission_rate: p.commissionRate ?? null,
      commission_estimated: p.commissionEstimated ?? null,
      sales: p.sales ?? null,
      rating: p.rating ?? null,
      product_url: p.productUrl,
      affiliate_url: p.affiliateUrl || rec.affiliate_url || '',
      image_url: p.imageUrl || rec.image_url || '',
      metadata_json: p.metadata || {},
      last_seen_at: now,
    });
    return { ...rec };
  }

  async createOffer(offer) {
    if (this.usePg()) {
      const res = await this.pg.query(
        `INSERT INTO offers (
           product_id, source_type, source_ref, title, price_text,
           commission_rate, original_url, affiliate_url, image_url, formatted_message, dedup_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          offer.productId || null,
          offer.sourceType,
          offer.sourceRef || '',
          offer.title || '',
          offer.priceText || '',
          offer.commissionRate ?? null,
          offer.originalUrl || '',
          offer.affiliateUrl,
          offer.imageUrl || '',
          offer.formattedMessage,
          offer.dedupHash,
        ]
      );
      return res.rows[0];
    }
    const rec = {
      id: this._memory.seq.offer++,
      product_id: offer.productId || null,
      source_type: offer.sourceType,
      source_ref: offer.sourceRef || '',
      title: offer.title || '',
      price_text: offer.priceText || '',
      commission_rate: offer.commissionRate ?? null,
      original_url: offer.originalUrl || '',
      affiliate_url: offer.affiliateUrl,
      image_url: offer.imageUrl || '',
      formatted_message: offer.formattedMessage,
      dedup_hash: offer.dedupHash,
      created_at: new Date().toISOString(),
    };
    this._memory.offers.push(rec);
    return { ...rec };
  }

  async hasRecentOfferByHash(dedupHash, withinHours = 24) {
    if (this.usePg()) {
      const res = await this.pg.query(
        `SELECT 1 FROM offers WHERE dedup_hash = $1 AND created_at >= NOW() - ($2 || ' hours')::interval LIMIT 1`,
        [dedupHash, String(withinHours)]
      );
      return res.rowCount > 0;
    }
    const cutoff = Date.now() - withinHours * 3600 * 1000;
    return this._memory.offers.some((o) => o.dedup_hash === dedupHash && Date.parse(o.created_at) >= cutoff);
  }

  async listOffers({ sourceType = null, limit = 50 } = {}) {
    if (this.usePg()) {
      const params = [];
      let where = '';
      if (sourceType) {
        params.push(sourceType);
        where = 'WHERE source_type = $1';
      }
      params.push(Math.min(200, Number(limit) || 50));
      const res = await this.pg.query(
        `SELECT * FROM offers ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
        params
      );
      return res.rows;
    }
    return this._memory.offers
      .filter((o) => !sourceType || o.source_type === sourceType)
      .slice(-limit)
      .reverse();
  }

  async recordConversion(conv) {
    if (this.usePg()) {
      const res = await this.pg.query(
        `INSERT INTO conversions_history (
           origin_url, resolved_url, affiliate_url, sub_ids_json, item_id, shop_id,
           product_title, price_text, commission_rate, image_url, requested_via, requester_ref
         ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          conv.originUrl,
          conv.resolvedUrl || '',
          conv.affiliateUrl,
          JSON.stringify(conv.subIds || []),
          conv.itemId || '',
          conv.shopId || '',
          conv.productTitle || '',
          conv.priceText || '',
          conv.commissionRate ?? null,
          conv.imageUrl || '',
          conv.requestedVia || 'panel',
          conv.requesterRef || '',
        ]
      );
      return res.rows[0];
    }
    const rec = {
      id: this._memory.seq.conversion++,
      origin_url: conv.originUrl,
      resolved_url: conv.resolvedUrl || '',
      affiliate_url: conv.affiliateUrl,
      sub_ids_json: conv.subIds || [],
      item_id: conv.itemId || '',
      shop_id: conv.shopId || '',
      product_title: conv.productTitle || '',
      price_text: conv.priceText || '',
      commission_rate: conv.commissionRate ?? null,
      image_url: conv.imageUrl || '',
      requested_via: conv.requestedVia || 'panel',
      requester_ref: conv.requesterRef || '',
      created_at: new Date().toISOString(),
    };
    this._memory.conversions.push(rec);
    return { ...rec };
  }

  async listConversions(limit = 30) {
    if (this.usePg()) {
      const res = await this.pg.query('SELECT * FROM conversions_history ORDER BY created_at DESC LIMIT $1', [limit]);
      return res.rows;
    }
    return this._memory.conversions.slice(-limit).reverse();
  }

  // ---------------- FILA DE MENSAGENS E PUBLICAÇÕES ----------------
  async enqueueJob({ idempotencyKey, offerId = null, destinationJid, payload, maxAttempts = 3 }) {
    if (this.usePg()) {
      const res = await this.pg.query(
        `INSERT INTO queue_jobs (idempotency_key, offer_id, destination_jid, payload_json, status, max_attempts)
         VALUES ($1, $2, $3, $4::jsonb, 'pending', $5)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [idempotencyKey, offerId, destinationJid, JSON.stringify(payload), maxAttempts]
      );
      return { inserted: res.rowCount > 0, job: res.rows[0] || null };
    }
    if (this._memory.queueJobs.some((j) => j.idempotency_key === idempotencyKey)) {
      return { inserted: false, job: null };
    }
    const now = new Date().toISOString();
    const job = {
      id: this._memory.seq.job++,
      idempotency_key: idempotencyKey,
      offer_id: offerId,
      destination_jid: destinationJid,
      payload_json: structuredClone(payload),
      status: 'pending',
      attempts: 0,
      max_attempts: maxAttempts,
      next_attempt_at: now,
      last_error: '',
      created_at: now,
      updated_at: now,
      sent_at: null,
    };
    this._memory.queueJobs.push(job);
    return { inserted: true, job: { ...job } };
  }

  async recoverStaleProcessingJobs() {
    if (this.usePg()) {
      const res = await this.pg.query(
        `UPDATE queue_jobs SET status = 'pending', updated_at = NOW() WHERE status = 'processing' RETURNING id`
      );
      return res.rowCount;
    }
    let count = 0;
    for (const j of this._memory.queueJobs) {
      if (j.status === 'processing') {
        j.status = 'pending';
        j.updated_at = new Date().toISOString();
        count++;
      }
    }
    return count;
  }

  async listReadyJobsByDestination(limit = 50) {
    if (this.usePg()) {
      const res = await this.pg.query(
        `SELECT * FROM queue_jobs
         WHERE status IN ('pending', 'failed') AND next_attempt_at <= NOW()
         ORDER BY created_at ASC, id ASC
         LIMIT $1`,
        [limit]
      );
      return res.rows;
    }
    const nowMs = Date.now();
    return this._memory.queueJobs
      .filter((j) => (j.status === 'pending' || j.status === 'failed') && Date.parse(j.next_attempt_at) <= nowMs)
      .slice(0, limit)
      .map((j) => ({ ...j }));
  }

  async markJobProcessing(jobId) {
    if (this.usePg()) {
      const res = await this.pg.query(
        `UPDATE queue_jobs SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
         WHERE id = $1 AND status IN ('pending', 'failed')
         RETURNING *`,
        [jobId]
      );
      return res.rows[0] || null;
    }
    const job = this._memory.queueJobs.find((j) => j.id === jobId && (j.status === 'pending' || j.status === 'failed'));
    if (!job) return null;
    job.status = 'processing';
    job.attempts += 1;
    job.updated_at = new Date().toISOString();
    return { ...job };
  }

  async markJobSent(jobId, whatsappMsgId = '') {
    if (this.usePg()) {
      return this.pg.withTransaction(async (client) => {
        const res = await client.query(
          `UPDATE queue_jobs SET status = 'sent', sent_at = NOW(), updated_at = NOW(), last_error = ''
           WHERE id = $1 RETURNING *`,
          [jobId]
        );
        const job = res.rows[0];
        if (job) {
          await client.query(
            `INSERT INTO publications_history (job_id, offer_id, destination_jid, status, whatsapp_msg_id)
             VALUES ($1, $2, $3, 'sent', $4)`,
            [job.id, job.offer_id, job.destination_jid, whatsappMsgId || '']
          );
        }
        return job;
      });
    }
    const job = this._memory.queueJobs.find((j) => j.id === jobId);
    if (!job) return null;
    const now = new Date().toISOString();
    job.status = 'sent';
    job.sent_at = now;
    job.updated_at = now;
    job.last_error = '';
    this._memory.publications.push({
      id: this._memory.seq.pub++,
      job_id: job.id,
      offer_id: job.offer_id,
      destination_jid: job.destination_jid,
      status: 'sent',
      whatsapp_msg_id: whatsappMsgId || '',
      error_message: '',
      published_at: now,
    });
    return { ...job };
  }

  async markJobFailed(jobId, { errorMessage, permanent = false, retryDelayMs = 15000 }) {
    if (this.usePg()) {
      return this.pg.withTransaction(async (client) => {
        const cur = await client.query('SELECT * FROM queue_jobs WHERE id = $1 FOR UPDATE', [jobId]);
        const job = cur.rows[0];
        if (!job) return null;
        const exhausted = permanent || job.attempts >= job.max_attempts;
        const nextStatus = exhausted ? 'dead_letter' : 'failed';
        const nextAt = new Date(Date.now() + retryDelayMs).toISOString();
        const upd = await client.query(
          `UPDATE queue_jobs SET status = $2, next_attempt_at = $3, last_error = $4, updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [jobId, nextStatus, nextAt, String(errorMessage || '').slice(0, 500)]
        );
        await client.query(
          `INSERT INTO publications_history (job_id, offer_id, destination_jid, status, error_message)
           VALUES ($1, $2, $3, 'failed', $4)`,
          [job.id, job.offer_id, job.destination_jid, String(errorMessage || '').slice(0, 500)]
        );
        return upd.rows[0];
      });
    }
    const job = this._memory.queueJobs.find((j) => j.id === jobId);
    if (!job) return null;
    const now = new Date().toISOString();
    const exhausted = permanent || job.attempts >= job.max_attempts;
    job.status = exhausted ? 'dead_letter' : 'failed';
    job.next_attempt_at = new Date(Date.now() + retryDelayMs).toISOString();
    job.last_error = String(errorMessage || '').slice(0, 500);
    job.updated_at = now;
    this._memory.publications.push({
      id: this._memory.seq.pub++,
      job_id: job.id,
      offer_id: job.offer_id,
      destination_jid: job.destination_jid,
      status: 'failed',
      whatsapp_msg_id: '',
      error_message: job.last_error,
      published_at: now,
    });
    return { ...job };
  }

  async getQueueStats() {
    if (this.usePg()) {
      const res = await this.pg.query(
        `SELECT status, COUNT(*)::int AS total FROM queue_jobs GROUP BY status`
      );
      const counts = { pending: 0, processing: 0, sent: 0, failed: 0, dead_letter: 0 };
      for (const r of res.rows) counts[r.status] = r.total;
      return counts;
    }
    const counts = { pending: 0, processing: 0, sent: 0, failed: 0, dead_letter: 0 };
    for (const j of this._memory.queueJobs) {
      counts[j.status] = (counts[j.status] || 0) + 1;
    }
    return counts;
  }

  async listPublications(limit = 50) {
    if (this.usePg()) {
      const res = await this.pg.query('SELECT * FROM publications_history ORDER BY published_at DESC LIMIT $1', [limit]);
      return res.rows;
    }
    return this._memory.publications.slice(-limit).reverse();
  }

  // ---------------- AUDITORIA ----------------
  async addAuditLog({ actor = 'admin', action, resource = '', details = {}, ipAddress = '' }) {
    if (this.usePg()) {
      await this.pg.query(
        `INSERT INTO audit_logs (actor, action, resource, details_json, ip_address)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [actor, action, resource, JSON.stringify(details || {}), ipAddress || '']
      );
      return;
    }
    this._memory.auditLogs.push({
      id: this._memory.seq.audit++,
      actor,
      action,
      resource,
      details_json: details || {},
      ip_address: ipAddress || '',
      created_at: new Date().toISOString(),
    });
  }

  async listAuditLogs(limit = 50) {
    if (this.usePg()) {
      const res = await this.pg.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1', [limit]);
      return res.rows;
    }
    return this._memory.auditLogs.slice(-limit).reverse();
  }

  // ---------------- ESTADO PERSISTENTE BAILEYS (CRIPTOGRAFADO) ----------------
  async getBaileysAuthEntry(sessionId, keyType, keyId) {
    if (this.usePg()) {
      const res = await this.pg.query(
        `SELECT payload_encrypted, version FROM baileys_auth_state
         WHERE session_id = $1 AND key_type = $2 AND key_id = $3 LIMIT 1`,
        [sessionId, keyType, keyId]
      );
      return res.rows[0] || null;
    }
    const k = `${sessionId}|${keyType}|${keyId}`;
    return this._memory.baileysAuth.get(k) || null;
  }

  async saveBaileysAuthEntries(sessionId, entries = []) {
    if (!entries.length) return;
    if (this.usePg()) {
      await this.pg.withTransaction(async (client) => {
        for (const item of entries) {
          if (item.payloadEncrypted === null) {
            await client.query(
              `DELETE FROM baileys_auth_state WHERE session_id = $1 AND key_type = $2 AND key_id = $3`,
              [sessionId, item.keyType, item.keyId]
            );
          } else {
            await client.query(
              `INSERT INTO baileys_auth_state (session_id, key_type, key_id, payload_encrypted, version, updated_at)
               VALUES ($1, $2, $3, $4, 1, NOW())
               ON CONFLICT (session_id, key_type, key_id) DO UPDATE SET
                 payload_encrypted = EXCLUDED.payload_encrypted,
                 version = baileys_auth_state.version + 1,
                 updated_at = NOW()`,
              [sessionId, item.keyType, item.keyId, item.payloadEncrypted]
            );
          }
        }
      });
      return;
    }
    const now = new Date().toISOString();
    for (const item of entries) {
      const k = `${sessionId}|${item.keyType}|${item.keyId}`;
      if (item.payloadEncrypted === null) {
        this._memory.baileysAuth.delete(k);
      } else {
        const cur = this._memory.baileysAuth.get(k);
        this._memory.baileysAuth.set(k, {
          session_id: sessionId,
          key_type: item.keyType,
          key_id: item.keyId,
          payload_encrypted: item.payloadEncrypted,
          version: cur ? cur.version + 1 : 1,
          updated_at: now,
        });
      }
    }
  }

  async clearBaileysAuthSession(sessionId) {
    if (this.usePg()) {
      await this.pg.query('DELETE FROM baileys_auth_state WHERE session_id = $1', [sessionId]);
      return;
    }
    const prefix = `${sessionId}|`;
    for (const k of [...this._memory.baileysAuth.keys()]) {
      if (k.startsWith(prefix)) this._memory.baileysAuth.delete(k);
    }
  }
}

module.exports = { Repository };
