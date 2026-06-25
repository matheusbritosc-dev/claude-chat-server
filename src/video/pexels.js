'use strict';

/**
 * Pexels + Pixabay — footage de B-roll e fallback de imagem de produto.
 * Inspirado no MoneyPrinterTurbo/app/services/material.py.
 *
 * Uso principal:
 *  1. Produto sem image_url → busca thumbnail de vídeo no Pexels
 *  2. Higgsfield indisponível → usa vídeo stock diretamente como base
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { withRetry } = require('../utils/retry');
const { createLogger } = require('../utils/logger');

const log = createLogger('pexels');

const PEXELS_API_KEY  = process.env.PEXELS_API_KEY;
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;
const VIDEOS_DIR      = path.join(__dirname, '../../tmp/videos');

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'ShopeeAutomation/1.0', ...headers } }, (res) => {
      // Segue redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    }).on('error', reject)
      .setTimeout(30000, function() { this.destroy(); reject(new Error('Timeout')); });
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    function doGet(u) {
      const lib = u.startsWith('https') ? https : http;
      lib.get(u, { headers: { 'User-Agent': 'ShopeeAutomation/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doGet(res.headers.location);
        }
        if (res.statusCode >= 400) return reject(new Error(`Download HTTP ${res.statusCode}`));
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(dest); });
        file.on('error', reject);
      }).on('error', reject)
        .setTimeout(120000, function() { this.destroy(); reject(new Error('Download timeout')); });
    }
    doGet(url);
  });
}

// ─── Pexels ───────────────────────────────────────────────────────────────────

async function searchPexelsVideo(query, { orientation = 'portrait', perPage = 15 } = {}) {
  if (!PEXELS_API_KEY) throw new Error('PEXELS_API_KEY não configurado');

  const qs  = new URLSearchParams({ query, per_page: perPage, orientation });
  const url = `https://api.pexels.com/videos/search?${qs}`;

  const resp = await withRetry(
    () => httpsGet(url, { Authorization: PEXELS_API_KEY }),
    { maxAttempts: 3, context: 'pexels-search' }
  );

  const videos = resp.videos || [];
  if (!videos.length) return null;

  // Prefere vídeo com melhor resolução HD
  const video  = videos[0];
  const files  = video.video_files || [];
  const hd     = files.find(f => f.height >= 1080 && f.width) ||
                 files.find(f => f.height >= 720)  ||
                 files[0];

  return {
    id:          video.id,
    url:         hd?.link,
    width:       hd?.width,
    height:      hd?.height,
    thumbnail:   video.image,    // URL da thumbnail (imagem estática)
    duration:    video.duration,
    source:      'pexels',
  };
}

async function searchPixabayVideo(query, { orientation = 'vertical', perPage = 20 } = {}) {
  if (!PIXABAY_API_KEY) throw new Error('PIXABAY_API_KEY não configurado');

  const qs = new URLSearchParams({
    key:        PIXABAY_API_KEY,
    q:          query,
    video_type: 'film',
    per_page:   perPage,
    orientation,
  });
  const url = `https://pixabay.com/api/videos/?${qs}`;

  const resp = await withRetry(() => httpsGet(url), { maxAttempts: 3, context: 'pixabay-search' });
  const hits = resp.hits || [];
  if (!hits.length) return null;

  const video  = hits[0];
  const videos = video.videos || {};
  const best   = videos.large || videos.medium || videos.small;

  return {
    id:        video.id,
    url:       best?.url,
    width:     best?.width,
    height:    best?.height,
    thumbnail: video.picture_id ? `https://i.vimeocdn.com/video/${video.picture_id}_960x540.jpg` : null,
    duration:  video.duration,
    source:    'pixabay',
  };
}

// ─── Interface pública ────────────────────────────────────────────────────────

/**
 * Busca vídeo de B-roll para um produto.
 * Tenta Pexels primeiro, depois Pixabay como fallback.
 * @param {string} query - Termo de busca (nome/categoria do produto)
 * @returns {object|null} - { url, thumbnail, source, ... }
 */
async function findBrollVideo(query) {
  // Simplifica a query: primeiras 2-3 palavras em inglês tendem a ter mais resultados
  const cleanQuery = query.replace(/[^\w\s]/g, '').split(' ').slice(0, 3).join(' ');
  log.info(`Buscando B-roll para: "${cleanQuery}"`);

  if (PEXELS_API_KEY) {
    try {
      const result = await searchPexelsVideo(cleanQuery);
      if (result?.url) { log.info(`Pexels: ${result.url.substring(0, 60)}`); return result; }
    } catch (err) {
      log.warn('Pexels falhou', { error: err.message });
    }
  }

  if (PIXABAY_API_KEY) {
    try {
      const result = await searchPixabayVideo(cleanQuery);
      if (result?.url) { log.info(`Pixabay: ${result.url.substring(0, 60)}`); return result; }
    } catch (err) {
      log.warn('Pixabay falhou', { error: err.message });
    }
  }

  log.warn(`Nenhum B-roll encontrado para "${cleanQuery}"`);
  return null;
}

/**
 * Baixa o vídeo de B-roll para disco e retorna o path local.
 */
async function downloadBroll(videoInfo, productId) {
  if (!videoInfo?.url) return null;
  if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

  const dest = path.join(VIDEOS_DIR, `broll_${productId}_${videoInfo.source}.mp4`);
  log.info(`Baixando B-roll (${videoInfo.source})...`);
  await downloadFile(videoInfo.url, dest);
  return dest;
}

/**
 * Retorna a URL da thumbnail do vídeo (pode ser usada como imagem do produto
 * quando image_url estiver ausente no Shopee).
 */
async function getThumbnailUrl(query) {
  const result = await findBrollVideo(query);
  return result?.thumbnail || null;
}

module.exports = { findBrollVideo, downloadBroll, getThumbnailUrl, searchPexelsVideo };
