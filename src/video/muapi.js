'use strict';

/**
 * muapi.ai — gateway de 60+ modelos image-to-video.
 * Fonte: github.com/Anil-matcha/Open-Generative-AI
 *
 * Fluxo:
 *  1. POST /api/v1/{model} → retorna request_id
 *  2. GET  /api/v1/predictions/{id}/result → polling até completed
 *
 * Modelos image-to-video recomendados para e-commerce:
 *   kling-image2video-v1-6-standard  (5s, alta qualidade)
 *   kling-image2video-v1-5-pro       (10s, mais detalhado)
 *   minimax-image2video              (alternativa rápida)
 */

const https = require('https');
const { withRetry, sleep } = require('../utils/retry');
const { createLogger } = require('../utils/logger');

const log = createLogger('muapi');

const API_KEY  = process.env.MUAPI_API_KEY;
const BASE     = 'api.muapi.ai';
const MODEL    = process.env.MUAPI_MODEL || 'kling-image2video-v1-6-standard';

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function apiCall(method, path, body = null) {
  if (!API_KEY) throw new Error('MUAPI_API_KEY não configurado');

  const payload = body ? JSON.stringify(body) : null;
  const headers = {
    'x-api-key':    API_KEY,   // muapi.ai exige x-api-key (não Bearer)
    'Content-Type': 'application/json',
  };
  if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: BASE, path, method, headers }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`muapi HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('muapi timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Geração de vídeo ─────────────────────────────────────────────────────────

async function generateVideo({ imageUrl, prompt, duration = 5, aspectRatio = '9:16' }) {
  log.info(`muapi: gerando vídeo com modelo ${MODEL}`);

  const body = {
    image_url:    imageUrl,
    prompt:       prompt || 'cinematic product showcase, professional lighting, smooth motion',
    duration,
    aspect_ratio: aspectRatio,
  };

  const resp = await withRetry(
    () => apiCall('POST', `/api/v1/${MODEL}`, body),
    { maxAttempts: 3, baseDelayMs: 3000, context: 'muapi-generate' }
  );

  const requestId = resp?.request_id || resp?.id;
  if (!requestId) throw new Error(`muapi sem request_id: ${JSON.stringify(resp)}`);
  log.info(`muapi: job criado ${requestId}`);
  return requestId;
}

async function pollResult(requestId, { maxWaitMs = 600000, intervalMs = 15000 } = {}) {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const resp = await withRetry(
      () => apiCall('GET', `/api/v1/predictions/${requestId}/result`),
      { maxAttempts: 3, baseDelayMs: 2000, context: 'muapi-poll' }
    );

    const status = resp?.status;
    log.debug(`muapi poll ${requestId}: ${status}`);

    if (status === 'completed' || status === 'succeeded') {
      const url = resp?.outputs?.[0] || resp?.output?.url || resp?.output?.[0] || resp?.video_url;
      if (!url) throw new Error('muapi: completed mas sem URL de vídeo');
      log.info(`muapi: vídeo pronto → ${url.substring(0, 60)}`);
      return url;
    }
    if (status === 'failed' || status === 'error') {
      throw new Error(`muapi job falhou: ${resp?.error || 'desconhecido'}`);
    }

    await sleep(intervalMs);
  }
  throw new Error(`muapi timeout aguardando ${requestId}`);
}

/**
 * Interface de alto nível: gera vídeo e aguarda resultado.
 * Retorna URL pública do vídeo gerado.
 */
async function run({ imageUrl, prompt }) {
  const requestId = await generateVideo({ imageUrl, prompt });
  return pollResult(requestId);
}

module.exports = { run, generateVideo, pollResult };
