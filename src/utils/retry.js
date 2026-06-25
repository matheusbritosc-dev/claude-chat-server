'use strict';

const { createLogger } = require('./logger');
const log = createLogger('retry');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Executa fn com exponential backoff em caso de erro.
 * @param {Function} fn - Função async a executar
 * @param {Object} opts
 * @param {number} opts.maxAttempts - Máximo de tentativas (default 3)
 * @param {number} opts.baseDelayMs - Delay base em ms (default 1000)
 * @param {string} opts.context - Nome para logging
 */
async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 1000, context = 'op' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      log.warn(`${context} falhou (tentativa ${attempt}/${maxAttempts}), retry em ${delay}ms`, {
        error: err.message
      });
      await sleep(delay);
    }
  }
  throw lastError;
}

module.exports = { withRetry, sleep };
