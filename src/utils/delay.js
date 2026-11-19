// ==============================================================================
// Utilitário de pausas e formatação de tempo
// Adaptado de gabrieldamasse-01/bot-de-automacao
// ==============================================================================

function sleep(ms) {
  const safeMs = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => {
    setTimeout(resolve, safeMs);
  });
}

async function randomDelay(minMs, maxMs) {
  const min = Math.max(0, Number(minMs) || 0);
  const max = Math.max(min, Number(maxMs) || min);
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  await sleep(delay);
  return delay;
}

function formatMs(ms) {
  const seconds = Math.floor((Number(ms) || 0) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
}

module.exports = { sleep, randomDelay, formatMs };
