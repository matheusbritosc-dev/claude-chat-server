'use strict';

/**
 * MÓDULO 3 — Video Editor / Post Composer
 *
 * Integra técnicas do MoneyPrinterTurbo:
 *  - Narração em voz pt-BR via Edge TTS (gratuito)
 *  - Captions persuasivos gerados por IA (Claude Haiku)
 *  - B-roll do Pexels quando produto não tem imagem
 *  - ffmpeg para composição final: overlay de texto, watermark, música, voz
 *
 * Fluxo por produto:
 *  1. Baixa vídeo bruto (Higgsfield ou B-roll)
 *  2. Gera narração TTS (se edge-tts disponível)
 *  3. Gera caption com IA (se ANTHROPIC_API_KEY configurado)
 *  4. Compõe vídeo final com ffmpeg
 *  5. Salva video_local_path, video_public_url e caption no banco
 */

const { execFile } = require('child_process');
const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

const { generateCaption, aiNarration } = require('./captioner');
const { generateTTS, getAudioDuration } = require('./tts');
const { query }  = require('../db/database');
const { createLogger } = require('../utils/logger');

const log = createLogger('editor');

const FORMAT         = process.env.VIDEO_FORMAT      || 'reels';
const MAX_DURATION   = parseInt(process.env.VIDEO_DURATION_MAX || '30');
const WATERMARK_PATH = process.env.WATERMARK_PATH    || path.join(__dirname, '../../assets/logo.png');
const MUSIC_PATH     = process.env.MUSIC_PATH        || path.join(__dirname, '../../assets/music/bg.mp3');
const PUBLIC_BASE    = (process.env.PUBLIC_BASE_URL  || 'http://localhost:3457').replace(/\/$/, '');
const OUTPUT_DIR     = path.join(__dirname, '../../tmp/videos');

const DIMENSIONS = {
  reels: { w: 1080, h: 1920 },
  feed:  { w: 1080, h: 1080 },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

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
        .setTimeout(90000, function() { this.destroy(); reject(new Error('Download timeout')); });
    }
    doGet(url);
  });
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', ...args], { timeout: 240000 }, (err, stdout, stderr) => {
      if (err) {
        log.error('ffmpeg erro', { stderr: stderr?.substring(0, 500) });
        return reject(new Error(`ffmpeg: ${err.message}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

function formatBRL(v) {
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// ─── Composição de vídeo ──────────────────────────────────────────────────────

async function compose({ product, rawVideoPath, ttsPath }) {
  const { w, h } = DIMENSIONS[FORMAT] || DIMENSIONS.reels;
  const filename   = `product_${product.id}_final.mp4`;
  const outputPath = path.join(OUTPUT_DIR, filename);
  const tmpPath    = path.join(OUTPUT_DIR, `product_${product.id}_tmp.mp4`);

  const priceText = product.price_discount > 0
    ? `DE ${formatBRL(product.price_original)} POR ${formatBRL(product.price_discount)}`
    : formatBRL(product.price_discount || product.price_original);
  const titleText = product.name.substring(0, 42).toUpperCase().replace(/[':]/g, ' ');
  const discount  = product.price_original > 0
    ? Math.round((1 - product.price_discount / product.price_original) * 100)
    : 0;

  // Filtro base: resize + pad + gradiente + texto
  const baseVf = [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `setsar=1`,
    `drawbox=x=0:y=ih*0.62:w=iw:h=ih*0.42:color=black@0.65:t=fill`,
    `drawtext=text='${titleText}':fontsize=46:fontcolor=white:x=(w-text_w)/2:y=h*0.66:shadowcolor=black@0.9:shadowx=2:shadowy=2`,
    `drawtext=text='${priceText}':fontsize=40:fontcolor=yellow:x=(w-text_w)/2:y=h*0.78:shadowcolor=black@0.9:shadowx=2:shadowy=2`,
    discount >= 5
      ? `drawtext=text='${discount}% OFF':fontsize=36:fontcolor=white:x=(w-text_w)/2:y=h*0.87:box=1:boxcolor=red@0.85:boxborderw=12`
      : `drawtext=text='VER NA BIO':fontsize=34:fontcolor=white:x=(w-text_w)/2:y=h*0.87:box=1:boxcolor=red@0.85:boxborderw=14`,
  ].join(',');

  const hasWatermark = fileExists(WATERMARK_PATH);
  const hasMusic     = fileExists(MUSIC_PATH);
  const hasTTS       = ttsPath && fileExists(ttsPath);

  // Determina duração do vídeo final
  let targetDuration = MAX_DURATION;
  if (hasTTS) {
    const ttsDur = await getAudioDuration(ttsPath);
    if (ttsDur) targetDuration = Math.min(Math.ceil(ttsDur) + 2, MAX_DURATION);
  }

  // Monta inputs ffmpeg
  const args = ['-i', rawVideoPath];
  let inputIdx = 1;
  const watermarkIdx = hasWatermark ? inputIdx++ : null;
  const musicIdx     = hasMusic     ? inputIdx++ : null;
  const ttsIdx       = hasTTS       ? inputIdx++ : null;

  if (hasWatermark) args.push('-i', WATERMARK_PATH);
  if (hasMusic)     args.push('-stream_loop', '-1', '-i', MUSIC_PATH);
  if (hasTTS)       args.push('-i', ttsPath);

  // Filtro complexo quando há watermark
  if (hasWatermark) {
    args.push(
      '-filter_complex',
      `[0:v]${baseVf}[vbase];[vbase][${watermarkIdx}:v]overlay=W-w-16:H-h-16[vout]`,
      '-map', '[vout]',
    );
  } else {
    args.push('-vf', baseVf);
  }

  // Mix de áudio: TTS + música de fundo
  if (hasTTS && hasMusic) {
    args.push(
      '-filter_complex',
      `[${musicIdx}:a]volume=0.15,afade=t=out:st=${Math.max(targetDuration - 2, 1)}:d=2[music];` +
      `[${ttsIdx}:a]volume=1.0[speech];[music][speech]amix=inputs=2:duration=longest[aout]`,
      '-map', '[aout]',
    );
  } else if (hasTTS) {
    args.push('-map', `${ttsIdx}:a`);
  } else if (hasMusic) {
    args.push(
      '-map', `${musicIdx}:a`,
      '-af', `volume=0.25,afade=t=out:st=${Math.max(targetDuration - 2, 1)}:d=2`,
    );
  }

  args.push(
    '-t',        String(targetDuration),
    '-c:v',      'libx264',
    '-preset',   'fast',
    '-crf',      '23',
    '-c:a',      'aac',
    '-b:a',      '128k',
    '-movflags', '+faststart',
    '-pix_fmt',  'yuv420p',
    tmpPath,
  );

  log.info(`Renderizando [${product.id}] ${FORMAT} ${w}×${h} ${targetDuration}s` +
    (hasTTS ? ' +TTS' : '') + (hasMusic ? ' +música' : '') + (hasWatermark ? ' +logo' : ''));

  await ffmpeg(args);
  fs.renameSync(tmpPath, outputPath);
  log.info(`Vídeo pronto: ${filename}`);

  return {
    localPath: outputPath,
    publicUrl: `${PUBLIC_BASE}/videos/${filename}`,
  };
}

// ─── Pipeline por produto ─────────────────────────────────────────────────────

async function processProduct(product) {
  ensureDir(OUTPUT_DIR);

  const rawPath = path.join(OUTPUT_DIR, `product_${product.id}_raw.mp4`);
  const ttsPath = path.join(OUTPUT_DIR, `product_${product.id}_tts.mp3`);

  // 1. Baixa vídeo bruto
  const rawUrl = product.video_raw_url;
  if (!rawUrl) throw new Error(`Produto [${product.id}] sem video_raw_url`);
  log.info(`Baixando vídeo bruto [${product.id}]`);
  await downloadFile(rawUrl, rawPath);

  // 2. Gera narração TTS (em paralelo com caption)
  let generatedTtsPath = null;
  const [{ caption }, narrationText] = await Promise.all([
    generateCaption(product),
    aiNarration(product).catch(() => null),
  ]);

  if (narrationText) {
    generatedTtsPath = await generateTTS({ text: narrationText, outputPath: ttsPath });
  }

  // 3. Compõe vídeo final
  const { localPath, publicUrl } = await compose({
    product,
    rawVideoPath: rawPath,
    ttsPath: generatedTtsPath,
  });

  // 4. Persiste no banco
  await query(
    `UPDATE products_queue
        SET status           = 'composed',
            video_local_path = $1,
            video_public_url = $2,
            caption          = $3,
            updated_at       = NOW()
      WHERE id = $4`,
    [localPath, publicUrl, caption, product.id]
  );

  // 5. Limpeza
  [rawPath, ttsPath].forEach(p => fs.unlink(p, () => {}));

  log.info(`Produto [${product.id}] composto. URL: ${publicUrl}`);
  return { localPath, publicUrl, caption };
}

async function run() {
  log.info('Iniciando editor / composer...');

  const result = await query(
    `SELECT * FROM products_queue WHERE status='video_ready' ORDER BY created_at ASC LIMIT 5`
  );

  log.info(`Produtos prontos para composição: ${result.rows.length}`);
  for (const p of result.rows) {
    try {
      await processProduct(p);
    } catch (err) {
      log.error(`Falha ao compor [${p.id}]`, { error: err.message });
      await query(
        `UPDATE products_queue SET status='compose_failed', error_msg=$1, updated_at=NOW() WHERE id=$2`,
        [err.message.substring(0, 500), p.id]
      );
    }
  }
  log.info('Composer concluído.');
}

module.exports = { run, processProduct };
