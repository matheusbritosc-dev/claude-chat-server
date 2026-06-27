'use strict';

/**
 * Avatar / Talking Head Generator
 *
 * Anima uma foto do usuário (assets/avatar/photo.jpg) sincronizando
 * com o áudio da voz clonada (lip sync).
 *
 * Provedores suportados (em ordem de preferência):
 *   1. Higgsfield Dubbing API (/v1/dubbing)
 *   2. muapi.ai lip sync
 *   3. ffmpeg simples: adiciona foto estática com fade-in (fallback visual)
 *
 * O clipe gerado (~5-10s) é usado como intro dos Reels:
 *   [Avatar falando sobre o produto] + [Vídeo do produto Higgsfield]
 *
 * Arquivo de avatar: assets/avatar/photo.jpg (foto do rosto do usuário)
 */

const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { execFile } = require('child_process');
const { withRetry, sleep } = require('../utils/retry');
const { createLogger }     = require('../utils/logger');

const log = createLogger('avatar');

const AVATAR_PHOTO   = process.env.AVATAR_PHOTO_PATH
  || path.join(__dirname, '../../assets/avatar/photo.jpg');
const HIGGSFIELD_KEY = process.env.HIGGSFIELD_API_KEY;
const MUAPI_KEY      = process.env.MUAPI_API_KEY;
const PUBLIC_BASE    = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const OUTPUT_DIR     = path.join(__dirname, '../../tmp/videos');
const ENABLED        = process.env.AVATAR_ENABLED !== 'false';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fileExists(p) { try { return p && fs.statSync(p).isFile(); } catch { return false; } }

function buildAuthHeaders(apiKey, authStyle) {
  // muapi.ai usa header x-api-key; Higgsfield usa Authorization: Bearer
  return authStyle === 'x-api-key'
    ? { 'x-api-key': apiKey }
    : { 'Authorization': `Bearer ${apiKey}` };
}

function apiPost(hostname, endpoint, body, apiKey, authStyle = 'bearer') {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path:   endpoint,
      method: 'POST',
      headers: {
        ...buildAuthHeaders(apiKey, authStyle),
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload);
    req.end();
  });
}

function apiGet(hostname, endpoint, apiKey, authStyle = 'bearer') {
  return new Promise((resolve, reject) => {
    https.get({ hostname, path: endpoint, headers: buildAuthHeaders(apiKey, authStyle) }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    function doGet(u) {
      const lib = u.startsWith('https') ? https : http;
      lib.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return doGet(res.headers.location);
        if (res.statusCode >= 400) return reject(new Error(`Download ${res.statusCode}`));
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(dest); });
        file.on('error', reject);
      }).on('error', reject);
    }
    doGet(url);
  });
}

function ffmpegExec(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', ...args], { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`ffmpeg: ${err.message}`));
      resolve();
    });
  });
}

// ─── Provedor 1: Higgsfield Dubbing ──────────────────────────────────────────

async function higgsfieldLipSync({ photoUrl, audioUrl }) {
  const body = {
    video_url: photoUrl,  // aceita imagem estática também
    audio_url: audioUrl,
    model:     'sync-1.6',
  };
  const resp = await withRetry(
    () => apiPost('api.higgsfield.ai', '/v1/dubbing', body, HIGGSFIELD_KEY),
    { maxAttempts: 3, baseDelayMs: 2000, context: 'higgsfield-lipsync' }
  );

  const jobId = resp?.job_id || resp?.id;
  if (!jobId) throw new Error(`Higgsfield dubbing sem job_id: ${JSON.stringify(resp)}`);

  // Polling
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    await sleep(10000);
    const status = await withRetry(
      () => apiGet('api.higgsfield.ai', `/v1/jobs/${jobId}`, HIGGSFIELD_KEY),
      { maxAttempts: 3, context: 'higgsfield-lipsync-poll' }
    );
    if (status?.status === 'completed') return status?.output?.url || status?.video_url;
    if (status?.status === 'failed') throw new Error('Higgsfield dubbing falhou');
  }
  throw new Error('Higgsfield dubbing timeout');
}

// ─── Provedor 2: muapi.ai lip sync ───────────────────────────────────────────

async function muapiLipSync({ photoUrl, audioUrl }) {
  // Modelo foto→vídeo falando. InfiniteTalk / WAN 2.2 s2v aceitam uma
  // imagem estática + áudio e geram o vídeo falando (image-to-video).
  // NÃO usar "latent-sync" aqui: latent-sync é vídeo→vídeo (precisa de
  // um vídeo de entrada, não de uma foto).
  const model = process.env.MUAPI_LIPSYNC_MODEL || 'infinitetalk-image-to-video';
  const resp = await withRetry(
    () => apiPost('api.muapi.ai', `/api/v1/${model}`, { image_url: photoUrl, audio_url: audioUrl }, MUAPI_KEY, 'x-api-key'),
    { maxAttempts: 3, baseDelayMs: 3000, context: 'muapi-lipsync' }
  );

  const requestId = resp?.request_id || resp?.id;
  if (!requestId) throw new Error(`muapi lip sync sem request_id: ${JSON.stringify(resp)}`);

  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    await sleep(12000);
    const result = await withRetry(
      () => apiGet('api.muapi.ai', `/api/v1/predictions/${requestId}/result`, MUAPI_KEY, 'x-api-key'),
      { maxAttempts: 3, context: 'muapi-lipsync-poll' }
    );
    const status = result?.status;
    if (status === 'completed' || status === 'succeeded') {
      // A API retorna outputs[] (plural). Mantém fallbacks por segurança.
      const url = result?.outputs?.[0] || result?.output?.url || result?.output?.[0] || result?.video_url;
      if (!url) throw new Error(`muapi lip sync completou sem URL: ${JSON.stringify(result).substring(0, 200)}`);
      return url;
    }
    if (status === 'failed' || status === 'error') throw new Error('muapi lip sync falhou');
  }
  throw new Error('muapi lip sync timeout');
}

// ─── Provedor 3: ffmpeg fallback (foto estática + áudio) ─────────────────────

async function staticPhotoVideo({ localPhotoPath, localAudioPath, outputPath, duration = 8 }) {
  await ffmpegExec([
    '-loop', '1',
    '-i',    localPhotoPath,
    '-i',    localAudioPath,
    '-vf',   'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1',
    '-t',    String(duration),
    '-c:v',  'libx264', '-preset', 'fast', '-crf', '23',
    '-c:a',  'aac', '-b:a', '128k',
    '-pix_fmt', 'yuv420p',
    '-shortest',
    outputPath,
  ]);
  log.info('Avatar estático gerado via ffmpeg');
  return outputPath;
}

// ─── Interface pública ────────────────────────────────────────────────────────

/**
 * Gera clipe do avatar falando.
 *
 * @param {object} opts
 * @param {string} opts.localAudioPath  - Path local do áudio da voz clonada
 * @param {string} opts.audioPublicUrl  - URL pública do áudio (para APIs externas)
 * @param {number} opts.productId
 * @returns {Promise<string|null>} - Path local do vídeo do avatar ou null
 */
async function generateAvatarClip({ localAudioPath, audioPublicUrl, productId }) {
  if (!ENABLED) return null;
  if (!fileExists(AVATAR_PHOTO)) {
    log.warn('Foto de avatar não encontrada', { path: AVATAR_PHOTO });
    log.warn('Coloque uma foto sua em: assets/avatar/photo.jpg');
    return null;
  }
  if (!fileExists(localAudioPath)) return null;

  const outputPath = path.join(OUTPUT_DIR, `avatar_${productId}.mp4`);

  // Tenta lip sync com APIs externas (precisa de URLs públicas)
  if (audioPublicUrl && PUBLIC_BASE) {
    const photoPublicUrl = `${PUBLIC_BASE}/avatar/photo.jpg`;

    if (HIGGSFIELD_KEY) {
      try {
        log.info('Gerando avatar com Higgsfield dubbing...');
        const videoUrl = await higgsfieldLipSync({ photoUrl: photoPublicUrl, audioUrl: audioPublicUrl });
        await downloadFile(videoUrl, outputPath);
        log.info(`Avatar Higgsfield salvo: ${path.basename(outputPath)}`);
        return outputPath;
      } catch (err) {
        log.warn('Higgsfield dubbing falhou', { error: err.message });
      }
    }

    if (MUAPI_KEY) {
      try {
        log.info('Gerando avatar com muapi.ai lip sync...');
        const videoUrl = await muapiLipSync({ photoUrl: photoPublicUrl, audioUrl: audioPublicUrl });
        await downloadFile(videoUrl, outputPath);
        log.info(`Avatar muapi.ai salvo: ${path.basename(outputPath)}`);
        return outputPath;
      } catch (err) {
        log.warn('muapi.ai lip sync falhou', { error: err.message });
      }
    }
  }

  // Fallback: foto estática animada com o áudio (sem lip sync real)
  log.info('Usando avatar estático (foto + áudio, sem lip sync)');
  try {
    const audioDur = await require('./tts').getAudioDuration(localAudioPath);
    await staticPhotoVideo({
      localPhotoPath: AVATAR_PHOTO,
      localAudioPath,
      outputPath,
      duration: audioDur ? Math.ceil(audioDur) + 1 : 8,
    });
    return outputPath;
  } catch (err) {
    log.error('Avatar fallback ffmpeg falhou', { error: err.message });
    return null;
  }
}

/**
 * Concatena o clipe do avatar com o vídeo do produto.
 * Resultado: [Avatar intro 5-10s] + [Produto Reel]
 */
async function prependAvatarToVideo({ avatarPath, productVideoPath, outputPath }) {
  const listFile = outputPath + '_list.txt';
  fs.writeFileSync(listFile, `file '${avatarPath}'\nfile '${productVideoPath}'\n`);

  await ffmpegExec([
    '-f',        'concat',
    '-safe',     '0',
    '-i',        listFile,
    '-c:v',      'libx264', '-preset', 'fast', '-crf', '23',
    '-c:a',      'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    '-pix_fmt',  'yuv420p',
    outputPath,
  ]);

  fs.unlink(listFile, () => {});
  log.info(`Vídeo final com avatar: ${path.basename(outputPath)}`);
  return outputPath;
}

module.exports = { generateAvatarClip, prependAvatarToVideo };
