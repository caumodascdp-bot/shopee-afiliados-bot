// ==============================================================================
// Gerador de Hash Seguro (scrypt) para ADMIN_PASSWORD_HASH
// Uso: npm run hash-password -- "MinhaSenhaForte123"
// ==============================================================================

const { hashPassword } = require('../src/utils/crypto');

const pwd = process.argv[2] || '';
if (!pwd || pwd.length < 8) {
  console.error('Uso: npm run hash-password -- "SuaSenhaComMinimo8Caracteres"');
  process.exit(1);
}

console.log(hashPassword(pwd));
