// ==============================================================================
// Script de execução manual das migrations Neon PostgreSQL
// ==============================================================================

const config = require('../src/config');
const { PostgresClient } = require('../src/database/postgres');
const { runMigrations } = require('../src/database/migrator');

async function main() {
  if (!config.databaseUrl) {
    console.error('ERRO: DATABASE_URL não configurada no ambiente.');
    process.exit(1);
  }
  const pgClient = new PostgresClient({ connectionString: config.databaseUrl, isTest: false });
  await pgClient.connect();
  const result = await runMigrations(pgClient);
  console.log('Resultado das migrations:', JSON.stringify(result, null, 2));
  await pgClient.close();
}

main().catch((err) => {
  console.error('Falha ao rodar migrations:', err.message);
  process.exit(1);
});
