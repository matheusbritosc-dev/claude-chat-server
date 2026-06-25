'use strict';

/**
 * MÓDULO 2 — Video Generator
 *
 * Provedor primário: Higgsfield AI (image-to-video cinematográfico)
 * Fallback 1:       muapi.ai (60+ modelos: Kling, Veo, etc.)
 * Fallback 2:       Pexels B-roll (quando produto não tem imagem)
 *
 * Em HIGGSFIELD_TEST_MODE=true usa vídeo de demonstração.
 */

const https = require('https');
const { query }             = require('../db/database');
const { withRetry, sleep }  = require('../utils/retry');
const { createLogger }      = require('../utils/logger');
const muapi                 = require('../video/muapi');
const { findBrollVideo, downloadBroll, getThumbnailUrl } = require('../video/pexels');

const log = createLogger('higgsfield');

const TEST_MODE      = process.env.HIGGSFIELD_TEST_MODE === 'true';
const API_KEY        = process.env.HIGGSFIELD_API_KEY;
const WEBHOOK_SECRET = process.env.HIGGSFIELD_WEBHOOK_SECRET;
const PUBLIC_BASE    = process.env.PUBLIC_BASE_URL || '';
const WEBHOOK_PATH   = process.env.WEBHOOK_PATH || '/webhook/higgsfield';

// Vídeo MP4 royalty-free para modo teste
const TEST_VIDEO_URL = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4';

const MOTION_PRESETS = ['dolly-in', 'zoom-out', 'product-reveal', 'ken-burns'];

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function apiRequest(endpoint, method = 'GET', body = null) {
  const url = `https://api.higgsfield.ai${endpoint}`;
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(url, opts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 300)}`));
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function higgsPost(endpoint, body) {
  return withRetry(() => apiRequest(endpoint, 'POST', body), {
    maxAttempts: 3, baseDelayMs: 2000, context: `higgsfield:${endpoint}`,
  });
}
function higgsGet(endpoint) {
  return withRetry(() => apiRequest(endpoint, 'GET'), {
    maxAttempts: 3, baseDelayMs: 2000, context: `higgsfield:GET${endpoint}`,
  });
}

// ─── API calls ────────────────────────────────────────────────────────────────

async function importImageUrl(imageUrl) {
  const resp = await higgsPost('/v1/media/import', { url: imageUrl });
  const mediaId = resp?.media_id || resp?.id;
  if (!mediaId) throw new Error(`Falha ao importar imagem: ${JSON.stringify(resp)}`);
  return mediaId;
}

async function generateVideo({ mediaId, productName, preset }) {
  const body = {
    model:        'DoP',
    prompt:       `Cinematic e-commerce product showcase: ${productName.substring(0, 80)}, professional studio lighting, clean white background, ${preset} camera motion, high quality`,
    medias:       [{ type: 'image', value: mediaId }],
    duration:     5,
    aspect_ratio: '9:16',
    ...(PUBLIC_BASE ? {
      webhook: { url: `${PUBLIC_BASE}${WEBHOOK_PATH}`, secret: WEBHOOK_SECRET },
    } : {}),
  };
  const resp = await higgsPost('/v1/generate/video', body);
  const jobId = resp?.job_id || resp?.id;
  if (!jobId) throw new Error(`Sem job_id: ${JSON.stringify(resp)}`);
  return jobId;
}

async function pollJobStatus(jobId, { maxWaitMs = 600000, intervalMs = 15000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const resp = await higgsGet(`/v1/jobs/${jobId}`);
    const status = resp?.status;
    log.debug(`Job ${jobId}: ${status}`);
    if (status === 'completed' || status === 'success') {
      const url = resp?.output?.url || resp?.video_url;
      if (!url) throw new Error('Job concluído mas sem URL de vídeo');
      return url;
    }
    if (status === 'failed' || status === 'error') {
      throw new Error(`Job ${jobId} falhou: ${resp?.error || 'desconhecido'}`);
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timeout aguardando job ${jobId}`);
}

// ─── Persistência ─────────────────────────────────────────────────────────────

async function markVideoReady(productId, rawVideoUrl, jobId) {
  await query(
    `UPDATE products_queue
        SET video_raw_url     = $1,
            higgsfield_job_id = $2,
            status            = 'video_ready',
            updated_at        = NOW()
      WHERE id = $3`,
    [rawVideoUrl, jobId || null, productId]
  );
}

async function markAwaitingWebhook(productId, jobId) {
  await query(
    `UPDATE products_queue
        SET higgsfield_job_id = $1,
            status            = 'awaiting_webhook',
            updated_at        = NOW()
      WHERE id = $2`,
    [jobId, productId]
  );
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

// ─── Processamento de produto ─────────────────────────────────────────────────

async function processProduct(product) {
  log.info(`Gerando vídeo [${product.id}]: ${product.name.substring(0, 50)}`);

  await query(`UPDATE products_queue SET status='generating', updated_at=NOW() WHERE id=$1`, [product.id]);

  // Modo teste: pula a API e usa vídeo de demonstração
  if (TEST_MODE) {
    await sleep(1000);
    await markVideoReady(product.id, TEST_VIDEO_URL, 'test-job');
    log.info(`[TESTE] Vídeo demo atribuído ao produto [${product.id}]`);
    return;
  }

  // Garante que temos uma image_url — usa Pexels se necessário
  let imageUrl = product.image_url;
  if (!imageUrl) {
    log.info(`[${product.id}] Sem imagem — buscando thumbnail no Pexels`);
    imageUrl = await getThumbnailUrl(product.name).catch(() => null);
    if (imageUrl) {
      await query(`UPDATE products_queue SET image_url=$1 WHERE id=$2`, [imageUrl, product.id]);
    }
  }

  if (!imageUrl) {
    // Sem imagem de jeito nenhum — tenta B-roll direto como vídeo raw
    log.info(`[${product.id}] Sem imagem — usando B-roll Pexels como vídeo base`);
    const broll = await findBrollVideo(product.name).catch(() => null);
    if (broll?.url) {
      await markVideoReady(product.id, broll.url, 'pexels-broll');
      return;
    }
    await markFailed(product.id, 'Sem imagem e sem B-roll disponível');
    return;
  }

  // Tenta Higgsfield (provedor primário)
  let lastError;
  for (const preset of MOTION_PRESETS) {
    try {
      const mediaId = await importImageUrl(imageUrl);
      const jobId   = await generateVideo({ mediaId, productName: product.name, preset });

      if (PUBLIC_BASE) {
        await markAwaitingWebhook(product.id, jobId);
        log.info(`Aguardando webhook para job ${jobId}`);
      } else {
        log.warn('PUBLIC_BASE_URL não configurado — usando polling');
        const videoUrl = await pollJobStatus(jobId);
        await markVideoReady(product.id, videoUrl, jobId);
      }
      return;
    } catch (err) {
      lastError = err;
      log.warn(`Higgsfield preset ${preset} falhou`, { error: err.message });
    }
  }

  // Fallback: muapi.ai
  if (process.env.MUAPI_API_KEY) {
    log.info(`[${product.id}] Higgsfield esgotado — tentando muapi.ai (${process.env.MUAPI_MODEL || 'kling'})`);
    try {
      const videoUrl = await muapi.run({
        imageUrl,
        prompt: `Cinematic e-commerce product showcase: ${product.name.substring(0, 60)}, professional studio lighting, 9:16 vertical`,
      });
      await markVideoReady(product.id, videoUrl, 'muapi');
      return;
    } catch (err) {
      log.warn('muapi.ai também falhou', { error: err.message });
    }
  }

  // Último recurso: B-roll Pexels como vídeo base
  if (process.env.PEXELS_API_KEY || process.env.PIXABAY_API_KEY) {
    log.info(`[${product.id}] Usando B-roll Pexels como última alternativa`);
    try {
      const broll = await findBrollVideo(product.name);
      if (broll?.url) {
        await markVideoReady(product.id, broll.url, 'pexels-fallback');
        return;
      }
    } catch (err) {
      log.warn('B-roll também falhou', { error: err.message });
    }
  }

  await markFailed(product.id, lastError?.message || 'Todos os provedores falharam');
  throw lastError;
}

async function run() {
  log.info(TEST_MODE ? 'Generator [MODO TESTE]' : 'Iniciando generator (Higgsfield + fallbacks)...');

  if (!TEST_MODE && !API_KEY && !process.env.MUAPI_API_KEY) {
    throw new Error('Nenhum provedor de vídeo configurado. Configure HIGGSFIELD_API_KEY, MUAPI_API_KEY ou use HIGGSFIELD_TEST_MODE=true');
  }

  const result = await query(
    `SELECT * FROM products_queue WHERE status='pending' ORDER BY created_at ASC LIMIT 5`
  );

  log.info(`Produtos na fila: ${result.rows.length}`);
  for (const p of result.rows) {
    try { await processProduct(p); }
    catch (err) { log.error(`Falha [${p.id}]`, { error: err.message }); }
  }
  log.info('Generator concluído.');
}

// ─── Handler de webhook ───────────────────────────────────────────────────────

async function handleWebhook(rawPayload, signature) {
  if (WEBHOOK_SECRET && signature) {
    const crypto = require('crypto');
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET)
      .update(typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload))
      .digest('hex');
    if (!signature.includes(expected)) throw new Error('Assinatura de webhook inválida');
  }

  const data   = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
  const jobId  = data.job_id || data.id;
  const status = data.status;
  const videoUrl = data.output?.url || data.video_url;

  log.info('Webhook Higgsfield', { jobId, status });
  if (!jobId) return { ignored: true };

  const res = await query(
    `SELECT id FROM products_queue WHERE higgsfield_job_id=$1 AND status='awaiting_webhook'`,
    [jobId]
  );
  if (!res.rows.length) { log.warn(`Job ${jobId} sem produto associado`); return { ignored: true }; }

  const productId = res.rows[0].id;

  if ((status === 'completed' || status === 'success') && videoUrl) {
    await markVideoReady(productId, videoUrl, jobId);
    return { processed: true, productId };
  }
  if (status === 'failed' || status === 'error') {
    await markFailed(productId, `Job ${jobId} falhou`);
    return { failed: true, productId };
  }
  return { ignored: true, status };
}

module.exports = { run, processProduct, handleWebhook };
