'use strict';

/**
 * MÓDULO 2 — Higgsfield Video Generator
 *
 * Para cada produto 'pending' na fila:
 *  1. Faz upload da imagem do produto
 *  2. Dispara geração de vídeo (image-to-video) com motion preset e-commerce
 *  3. Recebe resultado via webhook assíncrono
 *  4. Persiste video_url em products_queue
 */

const https = require('https');
const http  = require('http');
const { URL } = require('url');
const { query } = require('../db/database');
const { withRetry } = require('../utils/retry');
const { createLogger } = require('../utils/logger');

const log = createLogger('higgsfield');

const API_KEY         = process.env.HIGGSFIELD_API_KEY;
const WEBHOOK_SECRET  = process.env.HIGGSFIELD_WEBHOOK_SECRET;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
const WEBHOOK_PATH    = process.env.WEBHOOK_PATH || '/webhook/higgsfield';

// Presets recomendados para e-commerce (tentados em ordem)
const MOTION_PRESETS = ['dolly-in', 'zoom-out', 'product-reveal', 'ken-burns'];

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function request(urlStr, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const lib = parsed.protocol === 'https:' ? https : http;

    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers:  options.headers || {},
    };

    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 300)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });

    if (body) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      req.write(payload);
    }
    req.end();
  });
}

function higgsPost(endpoint, body) {
  const url = `https://api.higgsfield.ai${endpoint}`;
  return withRetry(() => request(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
  }, body), { maxAttempts: 3, baseDelayMs: 2000, context: `higgsfield:${endpoint}` });
}

function higgsGet(endpoint) {
  const url = `https://api.higgsfield.ai${endpoint}`;
  return withRetry(() => request(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${API_KEY}` },
  }), { maxAttempts: 3, baseDelayMs: 2000, context: `higgsfield:GET${endpoint}` });
}

// ─── Upload de imagem ─────────────────────────────────────────────────────────

async function importImageUrl(imageUrl) {
  log.debug('Importando imagem', { url: imageUrl.substring(0, 80) });
  const resp = await higgsPost('/v1/media/import', { url: imageUrl });
  const mediaId = resp?.media_id || resp?.id;
  if (!mediaId) throw new Error(`Falha ao importar imagem: ${JSON.stringify(resp)}`);
  return mediaId;
}

// ─── Geração de vídeo ─────────────────────────────────────────────────────────

async function generateVideo({ mediaId, productName, preset }) {
  log.info(`Gerando vídeo — preset: ${preset}`, { productName: productName.substring(0, 40) });

  const body = {
    model:   'DoP',
    prompt:  `Professional e-commerce product showcase of ${productName.substring(0, 80)}, cinematic lighting, clean background, ${preset} camera motion`,
    medias:  [{ type: 'image', value: mediaId }],
    duration: 5,
    aspect_ratio: '9:16',
    webhook: {
      url:    `${PUBLIC_BASE_URL}${WEBHOOK_PATH}`,
      secret: WEBHOOK_SECRET,
    },
  };

  const resp = await higgsPost('/v1/generate/video', body);
  const jobId = resp?.job_id || resp?.id;
  if (!jobId) throw new Error(`Sem job_id na resposta: ${JSON.stringify(resp)}`);
  log.info('Job criado', { jobId, preset });
  return jobId;
}

// ─── Status polling (fallback quando webhook não chega) ──────────────────────

async function pollJobStatus(jobId, { maxWaitMs = 300000, intervalMs = 10000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const resp = await higgsGet(`/v1/jobs/${jobId}`);
    const status = resp?.status;
    log.debug(`Job ${jobId} status: ${status}`);

    if (status === 'completed' || status === 'success') {
      const videoUrl = resp?.output?.url || resp?.video_url;
      if (!videoUrl) throw new Error('Job concluído mas sem video_url');
      return videoUrl;
    }
    if (status === 'failed' || status === 'error') {
      throw new Error(`Job ${jobId} falhou: ${resp?.error || 'desconhecido'}`);
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout aguardando job ${jobId}`);
}

// ─── Persistência ─────────────────────────────────────────────────────────────

async function updateProductVideo(productId, videoUrl, jobId) {
  await query(
    `UPDATE products_queue
        SET video_url   = $1,
            status      = 'video_ready',
            updated_at  = NOW()
      WHERE id = $2`,
    [videoUrl, productId]
  );
  log.info(`Produto ${productId} — vídeo salvo`, { jobId });
}

async function markFailed(productId, errorMsg) {
  await query(
    `UPDATE products_queue
        SET status        = 'video_failed',
            error_msg     = $1,
            attempt_count = attempt_count + 1,
            updated_at    = NOW()
      WHERE id = $2`,
    [errorMsg.substring(0, 500), productId]
  );
}

// ─── Pipeline principal ───────────────────────────────────────────────────────

async function processProduct(product) {
  log.info(`Processando produto [${product.id}]: ${product.name.substring(0, 50)}`);

  // Marca como em processamento
  await query(
    `UPDATE products_queue SET status = 'generating', updated_at = NOW() WHERE id = $1`,
    [product.id]
  );

  let lastError;
  for (const preset of MOTION_PRESETS) {
    try {
      const mediaId = await importImageUrl(product.image_url);
      const jobId   = await generateVideo({ mediaId, productName: product.name, preset });

      // Tenta via webhook (async); se PUBLIC_BASE_URL não configurado, faz polling
      if (!PUBLIC_BASE_URL) {
        log.warn('PUBLIC_BASE_URL não configurado — usando polling');
        const videoUrl = await pollJobStatus(jobId);
        await updateProductVideo(product.id, videoUrl, jobId);
      } else {
        // Salva jobId para o webhook associar depois
        await query(
          `UPDATE products_queue SET status = 'awaiting_webhook', error_msg = $1, updated_at = NOW() WHERE id = $2`,
          [jobId, product.id]
        );
        log.info(`Aguardando webhook para job ${jobId}`);
      }
      return;
    } catch (err) {
      lastError = err;
      log.warn(`Preset ${preset} falhou`, { error: err.message });
    }
  }

  await markFailed(product.id, lastError?.message || 'Todos os presets falharam');
  throw lastError;
}

async function run() {
  log.info('Iniciando Higgsfield generator...');

  if (!API_KEY) {
    throw new Error('HIGGSFIELD_API_KEY não configurado');
  }

  const result = await query(
    `SELECT * FROM products_queue
      WHERE status = 'pending'
        AND image_url IS NOT NULL
      ORDER BY created_at ASC
      LIMIT 5`
  );

  const products = result.rows;
  log.info(`Produtos na fila para gerar vídeo: ${products.length}`);

  for (const product of products) {
    try {
      await processProduct(product);
    } catch (err) {
      log.error(`Falha no produto [${product.id}]`, { error: err.message });
    }
  }

  log.info('Generator concluído.');
}

// ─── Handler de webhook ───────────────────────────────────────────────────────

async function handleWebhook(payload, signature) {
  // Valida assinatura HMAC
  if (WEBHOOK_SECRET && signature) {
    const crypto = require('crypto');
    const expected = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
      .digest('hex');
    if (!signature.includes(expected)) {
      throw new Error('Assinatura de webhook inválida');
    }
  }

  const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const jobId    = data.job_id || data.id;
  const status   = data.status;
  const videoUrl = data.output?.url || data.video_url;

  log.info(`Webhook recebido`, { jobId, status });

  if (!jobId) return { ignored: true };

  // error_msg está sendo usado temporariamente para guardar o jobId
  const res = await query(
    `SELECT id FROM products_queue WHERE error_msg = $1 AND status = 'awaiting_webhook'`,
    [jobId]
  );

  if (!res.rows.length) {
    log.warn(`Nenhum produto aguardando job ${jobId}`);
    return { ignored: true };
  }

  const productId = res.rows[0].id;

  if ((status === 'completed' || status === 'success') && videoUrl) {
    await query(
      `UPDATE products_queue
          SET video_url  = $1,
              status     = 'video_ready',
              error_msg  = NULL,
              updated_at = NOW()
        WHERE id = $2`,
      [videoUrl, productId]
    );
    log.info(`Vídeo pronto para produto [${productId}]`);
    return { processed: true, productId };
  }

  if (status === 'failed' || status === 'error') {
    await query(
      `UPDATE products_queue
          SET status     = 'video_failed',
              error_msg  = $1,
              updated_at = NOW()
        WHERE id = $2`,
      [`Job ${jobId} falhou`, productId]
    );
    return { failed: true, productId };
  }

  return { ignored: true, status };
}

module.exports = { run, processProduct, handleWebhook };
