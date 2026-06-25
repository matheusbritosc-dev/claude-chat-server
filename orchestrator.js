'use strict';

/**
 * Orquestrador principal — expõe servidor HTTP com:
 *  - Endpoint de webhooks (Higgsfield, Meta)
 *  - Endpoint de status /api/status
 *  - Trigger manual /api/run/:module
 * E gerencia o pipeline completo via cron agendado com node-cron.
 */

require('dotenv').config();

const http = require('http');
const { createWebhookMiddleware } = require('./src/webhook/server');
const { migrate, close }          = require('./src/db/database');
const { createLogger }            = require('./src/utils/logger');
const { query }                   = require('./src/db/database');

const log = createLogger('orchestrator');

const PORT = parseInt(process.env.PORT || '3457');

// ─── Pipeline ─────────────────────────────────────────────────────────────────

async function runPipeline(step) {
  switch (step) {
    case 'fetch': {
      const { run } = require('./src/shopee/fetcher');
      return run();
    }
    case 'generate': {
      const { run } = require('./src/higgsfield/generator');
      return run();
    }
    case 'compose': {
      const { run } = require('./src/editor/composer');
      return run();
    }
    case 'publish': {
      const { run } = require('./src/instagram/publisher');
      return run();
    }
    case 'respond': {
      const { run } = require('./src/instagram/responder');
      return run();
    }
    case 'full': {
      log.info('=== PIPELINE COMPLETO INICIADO ===');
      const steps = ['fetch', 'generate', 'compose', 'publish', 'respond'];
      for (const s of steps) {
        log.info(`-- Etapa: ${s} --`);
        await runPipeline(s);
      }
      log.info('=== PIPELINE COMPLETO FINALIZADO ===');
      return;
    }
    default:
      throw new Error(`Etapa desconhecida: ${step}`);
  }
}

// ─── Status do banco ──────────────────────────────────────────────────────────

async function getStatus() {
  const res = await query(
    `SELECT status, COUNT(*) as count
       FROM products_queue
      GROUP BY status
      ORDER BY status`
  );
  const byStatus = {};
  for (const row of res.rows) byStatus[row.status] = parseInt(row.count);
  return { uptime: process.uptime(), pid: process.pid, queue: byStatus };
}

// ─── Servidor HTTP ────────────────────────────────────────────────────────────

const webhookMiddleware = createWebhookMiddleware();

async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Webhooks
  const handled = await webhookMiddleware(req, res);
  if (handled !== null) return;

  // Status
  if (req.method === 'GET' && req.url === '/api/status') {
    try {
      const status = await getStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ...status }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // Trigger manual: POST /api/run/fetch|generate|compose|publish|respond|full
  const match = req.url.match(/^\/api\/run\/(\w+)$/);
  if (req.method === 'POST' && match) {
    const step = match[1];
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, step, message: `Iniciando ${step}...` }));

    setImmediate(async () => {
      try {
        await runPipeline(step);
        log.info(`Trigger manual '${step}' concluído.`);
      } catch (err) {
        log.error(`Trigger manual '${step}' falhou`, { error: err.message });
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

// ─── Cron scheduler (interno, sem dependência externa) ────────────────────────

function scheduleCron() {
  // Verifica a cada minuto se está na hora de rodar
  const FETCH_HOURS  = [7, 19];   // 07h e 19h
  const REPLY_EVERY  = 30;        // minutos

  let lastFetchDay = -1;
  let lastReplyMin = -1;

  setInterval(async () => {
    const now = new Date();
    const h   = now.getHours();
    const m   = now.getMinutes();
    const day = now.getDate();

    // Fetch: 07h00 e 19h00 uma vez por dia cada
    if (FETCH_HOURS.includes(h) && m === 0 && lastFetchDay !== `${day}-${h}`) {
      lastFetchDay = `${day}-${h}`;
      log.info(`[CRON] Disparando pipeline de fetch (${h}h)`);
      try {
        await runPipeline('fetch');
        await runPipeline('generate');
      } catch (err) {
        log.error('[CRON] Erro no fetch/generate', { error: err.message });
      }
    }

    // Compose + Publish: às 08h e 20h (1h depois do fetch)
    if ([8, 20].includes(h) && m === 0 && lastFetchDay !== `compose-${day}-${h}`) {
      lastFetchDay = `compose-${day}-${h}`;
      log.info(`[CRON] Disparando compose + publish (${h}h)`);
      try {
        await runPipeline('compose');
        await runPipeline('publish');
      } catch (err) {
        log.error('[CRON] Erro no compose/publish', { error: err.message });
      }
    }

    // Responder: a cada 30 minutos
    const totalMins = h * 60 + m;
    if (totalMins % REPLY_EVERY === 0 && lastReplyMin !== totalMins) {
      lastReplyMin = totalMins;
      try {
        await runPipeline('respond');
      } catch (err) {
        log.error('[CRON] Erro no responder', { error: err.message });
      }
    }
  }, 60 * 1000); // tick a cada 1 min
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function main() {
  log.info('Iniciando orquestrador...');

  await migrate();

  const server = http.createServer((req, res) => {
    req.setTimeout(120000);
    handleRequest(req, res).catch((err) => {
      log.error('Erro não tratado no handler', { error: err.message });
      try {
        res.writeHead(500);
        res.end('Internal Server Error');
      } catch {}
    });
  });

  server.listen(PORT, () => {
    log.info(`Orquestrador ouvindo na porta ${PORT}`);
    log.info(`Webhooks em POST ${process.env.WEBHOOK_PATH || '/webhook/higgsfield'}`);
    log.info(`Status em GET /api/status`);
    log.info(`Trigger manual: POST /api/run/{fetch|generate|compose|publish|respond|full}`);
  });

  scheduleCron();
  log.info('Cron scheduler ativo.');

  process.on('SIGTERM', async () => {
    log.info('SIGTERM recebido, encerrando...');
    server.close();
    await close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Falha fatal no boot:', err);
  process.exit(1);
});
