'use strict';

/**
 * MÓDULO 4 — Instagram Publisher
 *
 * Meta Graph API v21+ — fluxo correto para Reels:
 *  1. POST /{ig-user-id}/media com video_url (URL pública) + caption
 *  2. GET  /{container-id}?fields=status_code até FINISHED
 *  3. POST /{ig-user-id}/media_publish com creation_id
 *  4. Salva instagram_media_id e permalink no banco
 *
 * NOTA: O vídeo deve estar em uma URL HTTPS pública acessível pelo Meta.
 *       O orchestrator.js serve /videos/*.mp4 via HTTP.
 *       Para produção configure um domínio com HTTPS (nginx + certbot).
 *
 * Em META_TEST_MODE=true loga os dados sem publicar de verdade.
 */

const { query } = require('../db/database');
const { withRetry, sleep } = require('../utils/retry');
const { createLogger } = require('../utils/logger');
const meta = require('./metaClient');

const log = createLogger('instagram');

const TEST_MODE     = process.env.META_TEST_MODE === 'true';
const ACCESS_TOKEN  = meta.ACCESS_TOKEN;
const IG_ACCOUNT_ID = meta.ACCOUNT_ID;
const { graphGet, graphPost } = meta;

// ─── Verificação de token ─────────────────────────────────────────────────────

async function validateToken() {
  const resp = await meta.validateToken();
  log.info(`Token válido — conta: ${resp.username || resp.name} (${resp.id})`);
  return resp;
}

// ─── Criação de container Reels ───────────────────────────────────────────────

async function createReelsContainer(videoPublicUrl, caption) {
  log.info('Criando container de Reels...', { url: videoPublicUrl.substring(0, 80) });

  const resp = await withRetry(
    () => graphPost(`/${IG_ACCOUNT_ID}/media`, {
      media_type:    'REELS',
      video_url:     videoPublicUrl,   // URL HTTPS pública — Meta baixa o arquivo
      caption:       caption,
      share_to_feed: 'true',
    }),
    { maxAttempts: 3, baseDelayMs: 5000, context: 'ig-create-container' }
  );

  const containerId = resp.id;
  if (!containerId) throw new Error(`Container sem id: ${JSON.stringify(resp)}`);
  log.info(`Container criado: ${containerId}`);
  return containerId;
}

// ─── Polling até FINISHED ────────────────────────────────────────────────────

async function waitForContainer(containerId, { maxWaitMs = 600000 } = {}) {
  log.info(`Aguardando processamento do container ${containerId}...`);
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const resp = await graphGet(`/${containerId}`, { fields: 'status_code,status' });
    const code = resp.status_code;
    log.debug(`Container ${containerId}: ${code}`);

    if (code === 'FINISHED') return;
    if (code === 'ERROR')    throw new Error(`Container ${containerId} em ERROR. Verifique o vídeo (codec, tamanho, URL HTTPS).`);
    if (code === 'EXPIRED')  throw new Error(`Container ${containerId} expirou (>24h).`);

    await sleep(20000); // 20s entre verificações
  }
  throw new Error(`Timeout aguardando container ${containerId} (${maxWaitMs / 60000} min)`);
}

// ─── Publicação ───────────────────────────────────────────────────────────────

async function publishContainer(containerId) {
  const resp = await withRetry(
    () => graphPost(`/${IG_ACCOUNT_ID}/media_publish`, { creation_id: containerId }),
    { maxAttempts: 3, baseDelayMs: 5000, context: 'ig-publish' }
  );
  const mediaId = resp.id;
  if (!mediaId) throw new Error(`Publish sem media_id: ${JSON.stringify(resp)}`);
  log.info(`Publicado! Media ID: ${mediaId}`);
  return mediaId;
}

async function getPermalink(mediaId) {
  try {
    const resp = await graphGet(`/${mediaId}`, { fields: 'permalink,timestamp' });
    return resp.permalink || null;
  } catch { return null; }
}

// ─── Pipeline principal ───────────────────────────────────────────────────────

async function publishProduct(product) {
  const videoUrl = product.video_public_url;
  const caption  = product.caption || product.short_desc || '';

  if (!videoUrl) throw new Error(`Produto [${product.id}] sem video_public_url`);

  // Modo teste: não publica, apenas simula
  if (TEST_MODE) {
    log.info(`[TESTE] Simulando publicação do produto [${product.id}]`, { videoUrl, caption: caption.substring(0, 80) });
    const fakeMediaId = `test_media_${product.id}_${Date.now()}`;
    await query(
      `UPDATE products_queue
          SET status             = 'published',
              instagram_media_id = $1,
              instagram_post_url = $2,
              updated_at         = NOW()
        WHERE id = $3`,
      [fakeMediaId, `https://instagram.com/p/${fakeMediaId}`, product.id]
    );
    return { mediaId: fakeMediaId, permalink: null, test: true };
  }

  const containerId = await createReelsContainer(videoUrl, caption);
  await waitForContainer(containerId);
  const mediaId   = await publishContainer(containerId);
  const permalink = await getPermalink(mediaId);

  await query(
    `UPDATE products_queue
        SET status             = 'published',
            instagram_media_id = $1,
            instagram_post_url = $2,
            updated_at         = NOW()
      WHERE id = $3`,
    [mediaId, permalink, product.id]
  );

  log.info(`Post publicado [${product.id}]`, { mediaId, permalink });
  return { mediaId, permalink };
}

async function run() {
  log.info(TEST_MODE ? 'Instagram publisher [MODO TESTE]' : 'Iniciando Instagram publisher...');

  if (!TEST_MODE && (!ACCESS_TOKEN || !IG_ACCOUNT_ID)) {
    throw new Error('META_ACCESS_TOKEN ou META_INSTAGRAM_ACCOUNT_ID não configurados');
  }

  if (!TEST_MODE) {
    await validateToken().catch(err => {
      throw new Error(`Token Meta inválido: ${err.message}`);
    });
  }

  const result = await query(
    `SELECT * FROM products_queue WHERE status='composed' ORDER BY created_at ASC LIMIT 3`
  );

  log.info(`Posts prontos para publicar: ${result.rows.length}`);
  for (const p of result.rows) {
    try {
      await publishProduct(p);
      // Respeita rate limit do Instagram: mínimo 2 min entre posts
      if (result.rows.indexOf(p) < result.rows.length - 1) await sleep(120000);
    } catch (err) {
      log.error(`Falha ao publicar [${p.id}]`, { error: err.message });
      await query(
        `UPDATE products_queue SET status='publish_failed', error_msg=$1, updated_at=NOW() WHERE id=$2`,
        [err.message.substring(0, 500), p.id]
      );
    }
  }
  log.info('Publisher concluído.');
}

module.exports = { run, publishProduct, validateToken };
