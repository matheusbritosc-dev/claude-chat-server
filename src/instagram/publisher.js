'use strict';

/**
 * MÓDULO 4 — Instagram Publisher
 *
 * Publica Reels/posts via Meta Graph API v21+.
 * Fluxo:
 *  1. Upload do vídeo (container de mídia)
 *  2. Polling até FINISHED
 *  3. Publish (POST /{ig-user-id}/media_publish)
 *  4. Salva media_id e post_url em products_queue
 */

const https = require('https');
const fs    = require('fs');
const FormData = require('form-data');
const { query } = require('../db/database');
const { withRetry, sleep } = require('../utils/retry');
const { createLogger } = require('../utils/logger');

const log = createLogger('instagram');

const ACCESS_TOKEN  = process.env.META_ACCESS_TOKEN;
const IG_ACCOUNT_ID = process.env.META_INSTAGRAM_ACCOUNT_ID;
const GRAPH_VER     = 'v21.0';
const BASE          = `https://graph.facebook.com/${GRAPH_VER}`;

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function graphGet(endpoint, params = {}) {
  const qs = new URLSearchParams({ access_token: ACCESS_TOKEN, ...params });
  const url = `${BASE}${endpoint}?${qs}`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const parsed = JSON.parse(data);
        if (parsed.error) return reject(new Error(`Graph API: ${parsed.error.message}`));
        resolve(parsed);
      });
    }).on('error', reject);
  });
}

function graphPost(endpoint, body) {
  const url = `${BASE}${endpoint}`;
  const payload = JSON.stringify({ access_token: ACCESS_TOKEN, ...body });
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const parsed = JSON.parse(data);
        if (parsed.error) return reject(new Error(`Graph API: ${parsed.error.message}`));
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Usado para upload multipart (vídeo local)
function graphPostForm(endpoint, formData) {
  return new Promise((resolve, reject) => {
    const url = `${BASE}${endpoint}?access_token=${encodeURIComponent(ACCESS_TOKEN)}`;
    const req = https.request(url, {
      method:  'POST',
      headers: formData.getHeaders(),
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const parsed = JSON.parse(data);
        if (parsed.error) return reject(new Error(`Graph API upload: ${parsed.error.message}`));
        resolve(parsed);
      });
    });
    req.on('error', reject);
    formData.pipe(req);
  });
}

// ─── Upload de Reels ──────────────────────────────────────────────────────────

async function createReelsContainer(videoPath, caption) {
  log.info('Criando container de Reels...');

  // Para vídeos locais, fazemos upload via form-data
  const form = new FormData();
  form.append('media_type', 'REELS');
  form.append('caption', caption);
  form.append('share_to_feed', 'true');
  form.append('video_source', fs.createReadStream(videoPath));

  const resp = await withRetry(
    () => graphPostForm(`/${IG_ACCOUNT_ID}/media`, form),
    { maxAttempts: 3, baseDelayMs: 3000, context: 'ig-create-container' }
  );

  const containerId = resp.id;
  if (!containerId) throw new Error(`Container não retornou id: ${JSON.stringify(resp)}`);
  log.info(`Container criado: ${containerId}`);
  return containerId;
}

// ─── Polling de status ────────────────────────────────────────────────────────

async function waitForContainer(containerId, { maxWaitMs = 300000 } = {}) {
  log.info(`Aguardando container ${containerId}...`);
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const resp = await graphGet(`/${containerId}`, {
      fields: 'status_code,status'
    });

    const statusCode = resp.status_code;
    log.debug(`Container status: ${statusCode}`);

    if (statusCode === 'FINISHED') return true;
    if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
      throw new Error(`Container ${containerId} falhou com status: ${statusCode}`);
    }

    await sleep(15000); // aguarda 15s entre checks
  }

  throw new Error(`Timeout aguardando container ${containerId}`);
}

// ─── Publicação ───────────────────────────────────────────────────────────────

async function publishContainer(containerId) {
  log.info(`Publicando container ${containerId}...`);
  const resp = await withRetry(
    () => graphPost(`/${IG_ACCOUNT_ID}/media_publish`, { creation_id: containerId }),
    { maxAttempts: 3, baseDelayMs: 5000, context: 'ig-publish' }
  );

  const mediaId = resp.id;
  if (!mediaId) throw new Error(`Publish não retornou media id: ${JSON.stringify(resp)}`);
  log.info(`Publicado! Media ID: ${mediaId}`);
  return mediaId;
}

async function getPermalink(mediaId) {
  try {
    const resp = await graphGet(`/${mediaId}`, { fields: 'permalink' });
    return resp.permalink || null;
  } catch {
    return null;
  }
}

// ─── Pipeline principal ───────────────────────────────────────────────────────

async function publishProduct(product) {
  const videoPath = product.video_url;
  const caption   = product.short_desc; // short_desc é reaproveitado para a legenda composta

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Arquivo de vídeo não encontrado: ${videoPath}`);
  }

  const containerId = await createReelsContainer(videoPath, caption);
  await waitForContainer(containerId);
  const mediaId   = await publishContainer(containerId);
  const permalink = await getPermalink(mediaId);

  await query(
    `UPDATE products_queue
        SET status              = 'published',
            instagram_media_id  = $1,
            instagram_post_url  = $2,
            updated_at          = NOW()
      WHERE id = $3`,
    [mediaId, permalink, product.id]
  );

  log.info(`Post publicado [${product.id}]`, { mediaId, permalink });
  return { mediaId, permalink };
}

async function run() {
  log.info('Iniciando Instagram publisher...');

  if (!ACCESS_TOKEN || !IG_ACCOUNT_ID) {
    throw new Error('META_ACCESS_TOKEN ou META_INSTAGRAM_ACCOUNT_ID não configurados');
  }

  const result = await query(
    `SELECT * FROM products_queue
      WHERE status = 'composed'
      ORDER BY created_at ASC
      LIMIT 3`
  );

  const products = result.rows;
  log.info(`Posts prontos para publicar: ${products.length}`);

  for (const product of products) {
    try {
      await publishProduct(product);
    } catch (err) {
      log.error(`Falha ao publicar [${product.id}]`, { error: err.message });
      await query(
        `UPDATE products_queue
            SET status    = 'publish_failed',
                error_msg = $1,
                updated_at = NOW()
          WHERE id = $2`,
        [err.message.substring(0, 500), product.id]
      );
    }
  }

  log.info('Publisher concluído.');
}

module.exports = { run, publishProduct };
