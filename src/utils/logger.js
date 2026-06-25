'use strict';

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || 'info'] ?? 1;

function pad(n) { return String(n).padStart(2, '0'); }

function ts() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function log(level, module, msg, meta) {
  if (LOG_LEVELS[level] < currentLevel) return;
  const line = `[${ts()}] [${level.toUpperCase().padEnd(5)}] [${module}] ${msg}`;
  const out = meta ? `${line} ${JSON.stringify(meta)}` : line;
  (level === 'error' ? console.error : console.log)(out);
}

function createLogger(module) {
  return {
    debug: (msg, meta) => log('debug', module, msg, meta),
    info:  (msg, meta) => log('info',  module, msg, meta),
    warn:  (msg, meta) => log('warn',  module, msg, meta),
    error: (msg, meta) => log('error', module, msg, meta),
  };
}

module.exports = { createLogger };
