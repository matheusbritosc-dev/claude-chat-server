'use strict';

/**
 * Servidor de webhooks — recebe callbacks do Higgsfield
 * e do Meta (Instagram) na mesma porta do orquestrador.
 */

const http  = require('http');
const https = require('https');
const { handleWebhook } = require('../higgsfield/generator');
const { createLogger } = require('../utils/logger');

const log = createLogger('webhook');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function handleHiggsfieldWebhook(req, res) {
  const rawBody = await readBody(req);
  const signature = req.headers['x-higgsfield-signature'] || req.headers['x-webhook-signature'] || '';

  try {
    const result = await handleWebhook(rawBody, signature);
    log.info('Webhook Higgsfield processado', result);
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    log.error('Erro no webhook Higgsfield', { error: err.message });
    sendJson(res, 400, { ok: false, error: err.message });
  }
}

// Meta webhook verification (GET) + event handler (POST)
async function handleMetaWebhook(req, res) {
  if (req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const mode      = url.searchParams.get('hub.mode');
    const token     = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
      log.info('Meta webhook verificado.');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(challenge);
    }
    return sendJson(res, 403, { error: 'Verify token inválido' });
  }

  const rawBody = await readBody(req);
  log.debug('Meta webhook recebido', { body: rawBody.substring(0, 200) });
  sendJson(res, 200, { ok: true });
}

function createWebhookMiddleware() {
  const higgsfieldPath = process.env.WEBHOOK_PATH || '/webhook/higgsfield';

  return async function webhookMiddleware(req, res) {
    if (req.url === higgsfieldPath || req.url.startsWith(higgsfieldPath + '?')) {
      return handleHiggsfieldWebhook(req, res);
    }
    if (req.url.startsWith('/webhook/meta')) {
      return handleMetaWebhook(req, res);
    }
    return null; // Não tratado aqui
  };
}

module.exports = { createWebhookMiddleware };
