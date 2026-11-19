// ==============================================================================
// Executor de Migrations Versionadas para Neon PostgreSQL
// ==============================================================================

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function listMigrationFiles(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d+.*\.sql$/i.test(f))
    .sort((a, b) => a.localeCompare(b));
}

async function runMigrations(pgClient, migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const files = listMigrationFiles(migrationsDir);
  if (!pgClient || !pgClient.isPostgresActive()) {
    return { applied: [], skipped: files, mode: 'memory_fallback' };
  }

  await pgClient.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(64) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const appliedRes = await pgClient.query('SELECT version FROM schema_migrations');
  const alreadyApplied = new Set(appliedRes.rows.map((r) => r.version));
  const appliedNow = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/i, '');
    if (alreadyApplied.has(version)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await pgClient.withTransaction(async (client) => {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
        [version]
      );
    });
    appliedNow.push(version);
    logger.info(`[MIGRATOR] Migration aplicada: ${version}`);
  }

  return { applied: appliedNow, totalFiles: files.length, mode: 'postgres' };
}

module.exports = { runMigrations, listMigrationFiles, DEFAULT_MIGRATIONS_DIR };
