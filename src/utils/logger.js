// ==============================================================================
// Logger estruturado com sanitização de segredos e escrita opcional em arquivo
// Base adaptada de gabrieldamasse-01/bot-de-automacao
// ==============================================================================

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { higienizarArgumentos, higienizarTextoSegredos } = require('./filtro_log_criptografia');

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

let fileStream = null;

function ensureLogStream() {
  if (config.isTest) return null;
  if (fileStream) return fileStream;
  try {
    fs.mkdirSync(config.logsDir, { recursive: true });
    fileStream = fs.createWriteStream(path.join(config.logsDir, 'app.log'), { flags: 'a', encoding: 'utf8' });
    fileStream.on('error', () => {
      fileStream = null;
    });
  } catch (_) {
    fileStream = null;
  }
  return fileStream;
}

function currentThreshold() {
  const lvl = (process.env.LOG_LEVEL || config.logLevel || 'INFO').toUpperCase();
  return LOG_LEVELS[lvl] ?? LOG_LEVELS.INFO;
}

function writeLog(level, message, data) {
  if ((LOG_LEVELS[level] ?? 1) < currentThreshold()) return;

  const ts = new Date().toISOString();
  const safeMsg = higienizarTextoSegredos(String(message || ''));
  const safeArgs = data !== undefined ? higienizarArgumentos([data]) : [];
  const prefix = `[${ts}] [${level}]`;

  if (safeArgs.length > 0) {
    const serialized = typeof safeArgs[0] === 'string' ? safeArgs[0] : JSON.stringify(safeArgs[0]);
    const line = `${prefix} ${safeMsg} ${serialized}`;
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.log(line);
    ensureLogStream()?.write(`${line}\n`);
  } else {
    const line = `${prefix} ${safeMsg}`;
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.log(line);
    ensureLogStream()?.write(`${line}\n`);
  }
}

function closeLogger() {
  if (fileStream) {
    try {
      fileStream.end();
    } catch (_) {}
    fileStream = null;
  }
}

module.exports = {
  debug: (msg, data) => writeLog('DEBUG', msg, data),
  info: (msg, data) => writeLog('INFO', msg, data),
  warn: (msg, data) => writeLog('WARN', msg, data),
  error: (msg, data) => writeLog('ERROR', msg, data),
  closeLogger,
};
