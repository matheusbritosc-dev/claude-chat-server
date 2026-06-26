'use strict';

/**
 * MÓDULO — Instagram Stories Publisher
 *
 * Publica Stories via Meta Graph API v21+.
 * Suporta:
 *  - Story de vídeo (≤ 60s, 9:16 recomendado)
 *  - Story de imagem (com link sticker para afiliado)
 *  - Story gerado do avatar (intro pessoal + produto)
 *
 * Fluxo (igual ao de Reels):
 *  1. POST /{ig-user-id}/media com media_type=STORIES + video_url/image_url
 *  2. GET  /{container-id}?fields=status_code → aguarda FINISHED
 *  3. POST /{ig-user-id}/media_publish com creation_id
 */

const fs    = require('fs');
const path  = require('path');
const { execFile } = require('child_process');
const { query }         = require('../db/database');
const { withRetry, sleep } = require('../utils/retry');
const { createLogger }  = require('../utils/logger');
const meta = require('./metaClient');

const log = createLogger('stories');

const TEST_MODE     = process.env.META_TEST_MODE === 'true';
const ACCESS_TOKEN  = meta.ACCESS_TOKEN;
const IG_ACCOUNT_ID = meta.ACCOUNT_ID;
const PUBLIC_BASE   = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const VIDEOS_DIR    = path.join(__dirname, '../../tmp/videos');
const { graphGet, graphPost } = meta;

// ─── Preparo de Story de imagem com ffmpeg ────────────────────────────────────

function formatBRL(v) {
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

async function createStoryImage(product) {
  if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

  const outputPath = path.join(VIDEOS_DIR, `story_${product.id}.jpg`);
  const imageUrl   = product.image_url;
  if (!imageUrl) return null;

  const discount = product.price_original > 0
    ? Math.round((1 - product.price_discount / product.price_original) * 100)
    : 0;
  const priceText  = discount >= 5
    ? `${discount}% OFF - ${formatBRL(product.price_discount)}`
    : formatBRL(product.price_discount);
  const titleText  = product.name.substring(0, 35).toUpperCase().replace(/[':]/g, ' ');

  await new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-y',
      '-i', imageUrl,
      '-vf', [
        'scale=1080:1920:force_original_aspect_ratio=increase',
        'crop=1080:1920',
        'setsar=1',
        'drawbox=x=0:y=ih*0.6:w=iw:h=ih*0.45:color=black@0.75:t=fill',
        `drawtext=text='${titleText}':fontsize=52:fontcolor=white:x=(w-text_w)/2:y=h*0.65:shadowcolor=black@0.9:shadowx=2:shadowy=2`,
        `drawtext=text='${priceText}':fontsize=46:fontcolor=yellow:x=(w-text_w)/2:y=h*0.77:shadowcolor=black@0.9:shadowx=2:shadowy=2`,
        `drawtext=text='VER LINK NA BIO':fontsize=38:fontcolor=white:x=(w-text_w)/2:y=h*0.87:box=1:boxcolor=red@0.85:boxborderw=14`,
      ].join(','),
      '-frames:v', '1',
      '-q:v', '2',
      outputPath,
    ], { timeout: 30000 }, (err) => {
      if (err) { reject(err); } else { resolve(); }
    });
  });

  return outputPath;
}

// ─── Container e publicação ───────────────────────────────────────────────────

async function createStoryContainer({ mediaType, url, affiliateLink }) {
  log.info(`Criando container de Story (${mediaType})...`);

  const body = {
    media_type: 'STORIES',
    ...(mediaType === 'video' ? { video_url: url } : { image_url: url }),
  };

  // Link sticker — disponível para contas com >10k seguidores ou verificadas
  if (affiliateLink) {
    body.link = affiliateLink;
  }

  const resp = await withRetry(
    () => graphPost(`/${IG_ACCOUNT_ID}/media`, body),
    { maxAttempts: 3, baseDelayMs: 5000, context: 'story-container' }
  );

  if (!resp.id) throw new Error(`Story container sem id: ${JSON.stringify(resp)}`);
  log.info(`Container de Story criado: ${resp.id}`);
  return resp.id;
}

async function waitForStoryContainer(containerId) {
  log.info(`Aguardando Story container ${containerId}...`);
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const resp = await graphGet(`/${containerId}`, { fields: 'status_code' });
    const code = resp.status_code;
    log.debug(`Story container ${containerId}: ${code}`);
    if (code === 'FINISHED') return;
    if (code === 'ERROR')    throw new Error(`Story container em ERROR (verifique URL HTTPS e formato)`);
    if (code === 'EXPIRED')  throw new Error(`Story container expirou`);
    await sleep(15000);
  }
  throw new Error('Timeout aguardando Story container');
}

async function publishStoryContainer(containerId) {
  const resp = await withRetry(
    () => graphPost(`/${IG_ACCOUNT_ID}/media_publish`, { creation_id: containerId }),
    { maxAttempts: 3, baseDelayMs: 5000, context: 'story-publish' }
  );
  const mediaId = resp.id;
  if (!mediaId) throw new Error(`Story publish sem media_id: ${JSON.stringify(resp)}`);
  log.info(`Story publicado! Media ID: ${mediaId}`);
  return mediaId;
}

// ─── Stories a partir de Reel composto ───────────────────────────────────────

/**
 * Gera um Story de 15s a partir do vídeo do Reel (primeiros 15 segundos).
 */
async function trimForStory(videoPath, productId) {
  const outputPath = path.join(VIDEOS_DIR, `story_video_${productId}.mp4`);
  await new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-y', '-i', videoPath,
      '-t', '15',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-pix_fmt', 'yuv420p',
      outputPath,
    ], { timeout: 60000 }, (err) => {
      if (err) return reject(new Error(`ffmpeg trim: ${err.message}`));
      resolve();
    });
  });
  return outputPath;
}

// ─── Pipeline principal ───────────────────────────────────────────────────────

/**
 * Publica Story de vídeo (versão trimada do Reel).
 */
async function postVideoStory(product) {
  const videoPath = product.video_local_path;
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error(`Vídeo local não encontrado para Story: ${videoPath}`);
  }

  if (TEST_MODE) {
    log.info(`[TESTE] Simulando Story de vídeo [${product.id}]`);
    return { mediaId: `test_story_${product.id}`, test: true };
  }

  const storyPath = await trimForStory(videoPath, product.id);
  const storyFilename = path.basename(storyPath);
  const storyUrl = `${PUBLIC_BASE}/videos/${storyFilename}`;

  const containerId = await createStoryContainer({
    mediaType:    'video',
    url:          storyUrl,
    affiliateLink: product.affiliate_link,
  });
  await waitForStoryContainer(containerId);
  const mediaId = await publishStoryContainer(containerId);

  // Limpeza do clipe temporário de Story
  fs.unlink(storyPath, () => {});
  return { mediaId };
}

/**
 * Publica Story de imagem com overlay do preço do produto.
 */
async function postImageStory(product) {
  if (TEST_MODE) {
    log.info(`[TESTE] Simulando Story de imagem [${product.id}]`);
    return { mediaId: `test_story_img_${product.id}`, test: true };
  }

  // Gera imagem de Story com ffmpeg
  const imagePath = await createStoryImage(product);
  if (!imagePath) {
    throw new Error(`Não foi possível gerar imagem de Story para [${product.id}]`);
  }

  const storyFilename = path.basename(imagePath);
  const storyUrl = `${PUBLIC_BASE}/videos/${storyFilename}`;

  const containerId = await createStoryContainer({
    mediaType:     'image',
    url:           storyUrl,
    affiliateLink: product.affiliate_link,
  });
  await waitForStoryContainer(containerId);
  const mediaId = await publishStoryContainer(containerId);

  fs.unlink(imagePath, () => {});
  return { mediaId };
}

/**
 * Roda Stories para todos os produtos publicados nas últimas 2h.
 * Publica Story de vídeo (15s do Reel) + Story de imagem com link.
 */
async function run() {
  log.info(TEST_MODE ? 'Stories [MODO TESTE]' : 'Iniciando Stories publisher...');

  if (!TEST_MODE && (!ACCESS_TOKEN || !IG_ACCOUNT_ID)) {
    throw new Error('META_ACCESS_TOKEN ou META_INSTAGRAM_ACCOUNT_ID não configurados');
  }
  if (!PUBLIC_BASE && !TEST_MODE) {
    throw new Error('PUBLIC_BASE_URL deve ser HTTPS para Stories');
  }

  const result = await query(
    `SELECT * FROM products_queue
      WHERE status = 'published'
        AND instagram_media_id IS NOT NULL
        AND updated_at > NOW() - INTERVAL '2 hours'
      ORDER BY updated_at DESC
      LIMIT 3`
  );

  log.info(`Produtos para Stories: ${result.rows.length}`);

  for (const product of result.rows) {
    // Story de vídeo
    try {
      const { mediaId } = await postVideoStory(product);
      log.info(`Story de vídeo publicado [${product.id}]: ${mediaId}`);
    } catch (err) {
      log.warn(`Story vídeo falhou [${product.id}]`, { error: err.message });
    }

    await sleep(30000); // 30s entre Stories

    // Story de imagem com overlay de preço
    try {
      const { mediaId } = await postImageStory(product);
      log.info(`Story de imagem publicado [${product.id}]: ${mediaId}`);
    } catch (err) {
      log.warn(`Story imagem falhou [${product.id}]`, { error: err.message });
    }

    if (result.rows.indexOf(product) < result.rows.length - 1) await sleep(60000);
  }

  log.info('Stories publisher concluído.');
}

module.exports = { run, postVideoStory, postImageStory };
