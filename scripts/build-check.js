// ==============================================================================
// Verificação de Build de Produção (sintaxe JS, ausência de libs proibidas)
// ==============================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FORBIDDEN_PACKAGES = ['whatsapp-web.js', 'puppeteer', 'puppeteer-core', 'chromium', 'selenium-webdriver', 'playwright', 'sqlite3', 'better-sqlite3'];

function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'logs') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsFiles(full));
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.cjs')) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  for (const forbidden of FORBIDDEN_PACKAGES) {
    if (Object.prototype.hasOwnProperty.call(allDeps, forbidden)) {
      throw new Error(`Dependência proibida encontrada em package.json: ${forbidden}`);
    }
    if (fs.existsSync(path.join(ROOT, 'node_modules', forbidden))) {
      throw new Error(`Pacote proibido instalado em node_modules: ${forbidden}`);
    }
  }

  const files = collectJsFiles(ROOT);
  for (const file of files) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  }

  const requiredFiles = [
    'index.js',
    'render.yaml',
    'ecosystem.config.cjs',
    '.env.example',
    'src/database/migrations/001_initial_schema.sql',
    'public/index.html',
    'public/js/app.js',
    'public/css/styles.css',
    'cloudflare-worker/src/worker.js',
    'cloudflare-worker/wrangler.toml',
  ];
  for (const rel of requiredFiles) {
    if (!fs.existsSync(path.join(ROOT, rel))) {
      throw new Error(`Arquivo obrigatório ausente: ${rel}`);
    }
  }

  console.log(`BUILD OK: ${files.length} arquivos JS/CJS validados, 0 dependências proibidas, estrutura completa.`);
}

main();
