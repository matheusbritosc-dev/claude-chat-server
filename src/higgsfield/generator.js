'use strict';

/**
 * MÓDULO 2 — Video Generator
 *
 * Provedores em ordem de preferência:
 *  1. MoneyPrinterTurbo (auto-hospedado, GRATUITO) ← primário
 *  2. Higgsfield AI (pago)                         ← se HIGGSFIELD_API_KEY configurado
 *  3. muapi.ai (pago)                              ← se MUAPI_API_KEY configurado
 *  4. Pexels / Pixabay B-roll (gratuito)           ← fallback final
 *
 * HIGGSFIELD_TEST_MODE=true → pula tudo e usa vídeo de demonstração.
 */

const https = require('https');
const path  = require('path');
const { query }            = require('../db/database');
const { withRetry, sleep } = require('../utils/retry');
const { createLogger }     = require('../utils/logger');
const muapi                = require('../video/muapi');
const moneyprinter         = require('../video/moneyprinter');
const { findBrollVideo, getThumbnailUrl } = require('../video/pexels');

const log = createLogger('generator');

const TEST_MODE      = process.env.HIGGSFIELD_TEST_MODE === 'true';
const API_KEY        = process.env.HIGGSFIELD_API_KEY;
const WEBHOOK_SECRET = process.env.HIGGSFIELD_WEBHOOK_SECRET;
const PUBLIC_BASE    = process.env.PUBLIC_BASE_URL || '';
const WEBHOOK_PATH   = process.env.WEBHOOK_PATH || '/webhook/higgsfield';
const OUTPUT_DIR     = path.join(__dirname, '../../tmp/videos');

const TEST_VIDEO_URL = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4';
const MOTION_PRESETS = ['dolly-in', 'zoom-out', 'product-reveal', 'ken-burns'];

// ─── Higgsfield HTTP ──────────────────────────────────────────────────────────

function apiRequest(endpoint, method = 'GET', body = null) {
  const url = `https://api.higgsfield.ai${endpoint}`;
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
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

const higgsPost = (ep, body) => withRetry(() => apiRequest(ep, 'POST', body), { maxAttempts: 3, baseDelayMs: 2000, context: `higgsfield:${ep}` });
const higgsGet  = (ep)       => withRetry(() => apiRequest(ep, 'GET'),        { maxAttempts: 3, baseDelayMs: 2000, context: `higgsfield:GET${ep}` });

async function importImageUrl(imageUrl) {
  const resp = await higgsPost('/v1/media/import', { url: imageUrl });
  const mediaId = resp?.media_id || resp?.id;
  if (!mediaId) throw new Error(`Falha ao importar imagem: ${JSON.stringify(resp)}`);
  return mediaId;
}

async function generateHighgsfield({ mediaId, productName, preset }) {
  const body = {
    model:        'DoP',
    prompt:       `Cinematic e-commerce product showcase: ${productName.substring(0, 80)}, professional studio lighting, clean background, ${preset} camera motion, high quality`,
    medias:       [{ type: 'image', value: mediaId }],
    duration:     5,
    aspect_ratio: '9:16',
    ...(PUBLIC_BASE ? { webhook: { url: `${PUBLIC_BASE}${WEBHOOK_PATH}`, secret: WEBHOOK_SECRET } } : {}),
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
    if (status === 'completed' || status === 'success') {
      const url = resp?.output?.url || resp?.video_url;
      if (!url) throw new Error('Job concluído mas sem URL de vídeo');
      return url;
    }
    if (status === 'failed' || status === 'error') throw new Error(`Job ${jobId} falhou: ${resp?.error || 'desconhecido'}`);
    await sleep(intervalMs);
  }
  throw new Error(`Timeout aguardando job ${jobId}`);
}

// ─── Persistência ─────────────────────────────────────────────────────────────

async function markVideoReady(productId, rawVideoUrl, jobId) {
  await query(
    `UPDATE products_queue SET video_raw_url=$1, higgsfield_job_id=$2, status='video_ready', updated_at=NOW() WHERE id=$3`,
    [rawVideoUrl, jobId || null, productId]
  );
}

async function markAwaitingWebhook(productId, jobId) {
  await query(
    `UPDATE products_queue SET higgsfield_job_id=$1, status='awaiting_webhook', updated_at=NOW() WHERE id=$2`,
    [jobId, productId]
  );
}

async function markFailed(productId, errorMsg) {
  await query(
    `UPDATE products_queue SET status='video_failed', error_msg=$1, attempt_count=attempt_count+1, updated_at=NOW() WHERE id=$2`,
    [errorMsg.substring(0, 500), productId]
  );
}

// ─── Processamento ────────────────────────────────────────────────────────────

async function processProduct(product) {
  log.info(`Gerando vídeo [${product.id}]: ${product.name.substring(0, 50)}`);
  await query(`UPDATE products_queue SET status='generating', updated_at=NOW() WHERE id=$1`, [product.id]);

  // Modo teste
  if (TEST_MODE) {
    await sleep(500);
    await markVideoReady(product.id, TEST_VIDEO_URL, 'test-job');
    log.info(`[TESTE] Vídeo demo [${product.id}]`);
    return;
  }

  const fs   = require('fs');
  const { mkdirSync } = fs;
  if (!fs.existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  // ── PROVEDOR 1: MoneyPrinterTurbo (gratuito, auto-hospedado) ─────────────
  if (process.env.MONEYPRINTER_BASE_URL || await moneyprinter.isAvailable()) {
    try {
      const destPath = path.join(OUTPUT_DIR, `product_${product.id}_mpt.mp4`);
      await moneyprinter.generateVideo({
        subject:  `${product.name} — oferta imperdível com desconto`,
        language: 'pt',
        destPath,
      });
      await markVideoReady(product.id, `file://${destPath}`, 'moneyprinter');
      // Salva path local diretamente no video_raw_url como caminho de arquivo
      await query(
        `UPDATE products_queue SET video_raw_url=$1, updated_at=NOW() WHERE id=$2`,
        [destPath, product.id]
      );
      log.info(`[MoneyPrinterTurbo] Vídeo gerado: ${path.basename(destPath)}`);
      return;
    } catch (err) {
      log.warn(`MoneyPrinterTurbo falhou: ${err.message} — tentando próximo provedor`);
    }
  }

  // ── PROVEDOR 2: Higgsfield AI (pago) ──────────────────────────────────────
  if (API_KEY) {
    let imageUrl = product.image_url;
    if (!imageUrl) {
      imageUrl = await getThumbnailUrl(product.name).catch(() => null);
      if (imageUrl) await query(`UPDATE products_queue SET image_url=$1 WHERE id=$2`, [imageUrl, product.id]);
    }

    if (imageUrl) {
      let lastError;
      for (const preset of MOTION_PRESETS) {
        try {
          const mediaId = await importImageUrl(imageUrl);
          const jobId   = await generateHighgsfield({ mediaId, productName: product.name, preset });
          if (PUBLIC_BASE) {
            await markAwaitingWebhook(product.id, jobId);
            log.info(`Higgsfield: aguardando webhook job ${jobId}`);
          } else {
            const videoUrl = await pollJobStatus(jobId);
            await markVideoReady(product.id, videoUrl, jobId);
          }
          return;
        } catch (err) {
          lastError = err;
          log.warn(`Higgsfield preset ${preset} falhou`, { error: err.message });
        }
      }
      log.warn('Higgsfield esgotou todos os presets');
    }
  }

  // ── PROVEDOR 3: muapi.ai (pago) ───────────────────────────────────────────
  if (process.env.MUAPI_API_KEY) {
    const imageUrl = product.image_url || await getThumbnailUrl(product.name).catch(() => null);
    if (imageUrl) {
      try {
        const videoUrl = await muapi.run({
          imageUrl,
          prompt: `Cinematic e-commerce product showcase: ${product.name.substring(0, 60)}, professional studio lighting, 9:16 vertical`,
        });
        await markVideoReady(product.id, videoUrl, 'muapi');
        log.info(`muapi.ai: vídeo gerado [${product.id}]`);
        return;
      } catch (err) {
        log.warn('muapi.ai falhou', { error: err.message });
      }
    }
  }

  // ── PROVEDOR 4: Pexels / Pixabay B-roll (gratuito) ───────────────────────
  if (process.env.PEXELS_API_KEY || process.env.PIXABAY_API_KEY) {
    try {
      const broll = await findBrollVideo(product.name);
      if (broll?.url) {
        await markVideoReady(product.id, broll.url, 'pexels-fallback');
        log.info(`Pexels B-roll [${product.id}]: ${broll.url}`);
        return;
      }
    } catch (err) {
      log.warn('Pexels B-roll falhou', { error: err.message });
    }
  }

  await markFailed(product.id, 'Todos os provedores de vídeo falharam');
  throw new Error('Todos os provedores de vídeo falharam');
}

async function run() {
  const providers = [];
  if (!TEST_MODE) {
    if (process.env.MONEYPRINTER_BASE_URL) providers.push('MoneyPrinterTurbo');
    if (API_KEY) providers.push('Higgsfield');
    if (process.env.MUAPI_API_KEY) providers.push('muapi.ai');
    if (process.env.PEXELS_API_KEY || process.env.PIXABAY_API_KEY) providers.push('Pexels');
    if (!providers.length) {
      throw new Error(
        'Nenhum provedor configurado. Inicie o MoneyPrinterTurbo em localhost:8080 ' +
        'ou configure HIGGSFIELD_API_KEY / MUAPI_API_KEY / PEXELS_API_KEY'
      );
    }
  }

  log.info(TEST_MODE ? 'Generator [MODO TESTE]' : `Generator iniciado. Provedores: ${providers.join(' → ')}`);

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

// ─── Webhook Higgsfield ───────────────────────────────────────────────────────

async function handleWebhook(rawPayload, signature) {
  if (WEBHOOK_SECRET && signature) {
    const crypto = require('crypto');
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET)
      .update(typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload))
      .digest('hex');
    if (!signature.includes(expected)) throw new Error('Assinatura inválida');
  }

  const data     = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
  const jobId    = data.job_id || data.id;
  const status   = data.status;
  const videoUrl = data.output?.url || data.video_url;

  log.info('Webhook Higgsfield', { jobId, status });
  if (!jobId) return { ignored: true };

  const res = await query(
    `SELECT id FROM products_queue WHERE higgsfield_job_id=$1 AND status='awaiting_webhook'`,
    [jobId]
  );
  if (!res.rows.length) return { ignored: true };
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
