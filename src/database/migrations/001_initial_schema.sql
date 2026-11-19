-- ==============================================================================
-- Migration 001: Schema inicial do Shopee Afiliados Bot (Neon PostgreSQL)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_settings (
  key VARCHAR(128) PRIMARY KEY,
  value_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shopee_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  app_id VARCHAR(128) NOT NULL DEFAULT '',
  secret_key_encrypted TEXT NOT NULL DEFAULT '',
  default_sub_id VARCHAR(64) NOT NULL DEFAULT 'whatsapp_grupos',
  sub_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_tested_at TIMESTAMPTZ,
  last_test_status VARCHAR(32) NOT NULL DEFAULT 'untested',
  last_test_error TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS whatsapp_groups (
  jid VARCHAR(128) PRIMARY KEY,
  name VARCHAR(255) NOT NULL DEFAULT '',
  participants_count INTEGER NOT NULL DEFAULT 0,
  is_source BOOLEAN NOT NULL DEFAULT FALSE,
  is_destination BOOLEAN NOT NULL DEFAULT FALSE,
  rules_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hunter_keywords (
  id SERIAL PRIMARY KEY,
  keyword VARCHAR(160) NOT NULL UNIQUE,
  min_commission_rate NUMERIC(6, 4) NOT NULL DEFAULT 0,
  min_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
  max_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
  min_sales INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  item_id VARCHAR(64) NOT NULL,
  shop_id VARCHAR(64) NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  shop_name VARCHAR(255) NOT NULL DEFAULT '',
  price_min NUMERIC(12, 2) NOT NULL DEFAULT 0,
  price_max NUMERIC(12, 2) NOT NULL DEFAULT 0,
  discount_percent NUMERIC(6, 2),
  commission_rate NUMERIC(8, 6),
  commission_estimated NUMERIC(12, 2),
  sales INTEGER,
  rating NUMERIC(4, 2),
  product_url TEXT NOT NULL,
  affiliate_url TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (item_id, shop_id)
);

CREATE TABLE IF NOT EXISTS offers (
  id SERIAL PRIMARY KEY,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  source_type VARCHAR(32) NOT NULL CHECK (source_type IN ('group_mirror', 'hunter', 'converter')),
  source_ref VARCHAR(160) NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  price_text VARCHAR(64) NOT NULL DEFAULT '',
  commission_rate NUMERIC(8, 6),
  original_url TEXT NOT NULL DEFAULT '',
  affiliate_url TEXT NOT NULL,
  image_url TEXT NOT NULL DEFAULT '',
  formatted_message TEXT NOT NULL,
  dedup_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversions_history (
  id SERIAL PRIMARY KEY,
  origin_url TEXT NOT NULL,
  resolved_url TEXT NOT NULL DEFAULT '',
  affiliate_url TEXT NOT NULL,
  sub_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  item_id VARCHAR(64) NOT NULL DEFAULT '',
  shop_id VARCHAR(64) NOT NULL DEFAULT '',
  product_title TEXT NOT NULL DEFAULT '',
  price_text VARCHAR(64) NOT NULL DEFAULT '',
  commission_rate NUMERIC(8, 6),
  image_url TEXT NOT NULL DEFAULT '',
  requested_via VARCHAR(32) NOT NULL CHECK (requested_via IN ('panel', 'whatsapp_private', 'mirror', 'hunter')),
  requester_ref VARCHAR(128) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS queue_jobs (
  id SERIAL PRIMARY KEY,
  idempotency_key VARCHAR(128) NOT NULL UNIQUE,
  offer_id INTEGER REFERENCES offers(id) ON DELETE SET NULL,
  destination_jid VARCHAR(128) NOT NULL,
  payload_json JSONB NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS publications_history (
  id SERIAL PRIMARY KEY,
  job_id INTEGER REFERENCES queue_jobs(id) ON DELETE SET NULL,
  offer_id INTEGER REFERENCES offers(id) ON DELETE SET NULL,
  destination_jid VARCHAR(128) NOT NULL,
  status VARCHAR(24) NOT NULL CHECK (status IN ('sent', 'failed')),
  whatsapp_msg_id VARCHAR(128) NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  actor VARCHAR(64) NOT NULL DEFAULT 'system',
  action VARCHAR(96) NOT NULL,
  resource VARCHAR(96) NOT NULL DEFAULT '',
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address VARCHAR(64) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS baileys_auth_state (
  session_id VARCHAR(64) NOT NULL,
  key_type VARCHAR(64) NOT NULL,
  key_id VARCHAR(255) NOT NULL,
  payload_encrypted TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, key_type, key_id)
);

-- Índices para consultas operacionais e recuperação de fila
CREATE INDEX IF NOT EXISTS idx_queue_jobs_status_next_dest
  ON queue_jobs (status, next_attempt_at, destination_jid);

CREATE INDEX IF NOT EXISTS idx_offers_dedup_created
  ON offers (dedup_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_publications_dest_date
  ON publications_history (destination_jid, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversions_created
  ON conversions_history (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created
  ON audit_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_baileys_auth_session_type
  ON baileys_auth_state (session_id, key_type);
