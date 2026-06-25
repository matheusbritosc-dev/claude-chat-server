'use strict';

/**
 * MÓDULO 3 — Video Editor / Post Composer
 *
 * Para cada produto com status 'video_ready':
 *  a) Baixa o vídeo bruto (Higgsfield)
 *  b) Aplica overlay de texto, watermark e música via ffmpeg
 *  c) Formata 9:16 (1080×1920) Reels ou 1:1 feed, máx 30s
 *  d) Salva video_local_path (disco) e video_public_url (URL para Instagram)
 *  e) Gera caption automática e salva em products_queue.caption
 */

const { execFile } = require('child_process');
const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');
const { query } = require('../db/database');
const { createLogger } = require('../utils/logger');

const log = createLogger('editor');

const FORMAT         = process.env.VIDEO_FORMAT      || 'reels';
const MAX_DURATION   = parseInt(process.env.VIDEO_DURATION_MAX || '30');
const WATERMARK_PATH = process.env.WATERMARK_PATH    || path.join(__dirname, '../../assets/logo.png');
const MUSIC_PATH     = process.env.MUSIC_PATH        || path.join(__dirname, '../../assets/music/bg.mp3');
const HASHTAGS       = process.env.AFFILIATE_HASHTAGS || '#shopee #oferta #promocao #comprinhas #lojaonline';
const CTA            = process.env.AFFILIATE_CTA      || '🔗 Link na bio!';
const PUBLIC_BASE    = process.env.PUBLIC_BASE_URL    || 'http://localhost:3457';
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
      lib.get(u, (res) => {
        // Segue redirect
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doGet(res.headers.location);
        }
        if (res.statusCode >= 400) return reject(new Error(`Download falhou HTTP ${res.statusCode}`));
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
    execFile('ffmpeg', ['-y', ...args], { timeout: 180000 }, (err, stdout, stderr) => {
      if (err) {
        log.error('ffmpeg erro', { stderr: stderr.substring(0, 500) });
        return reject(new Error(`ffmpeg: ${err.message}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

// ─── Legenda automática ───────────────────────────────────────────────────────

function formatBRL(v) {
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function buildCaption(product) {
  const discount = product.price_original > 0
    ? Math.round((1 - product.price_discount / product.price_original) * 100)
    : 0;

  return [
    `🛍️ ${product.name}`,
    '',
    discount >= 5
      ? `✂️ De ${formatBRL(product.price_original)} por apenas ${formatBRL(product.price_discount)} — ${discount}% OFF!`
      : `💰 Por apenas ${formatBRL(product.price_discount)}`,
    '',
    CTA,
    '',
    product.short_desc ? `📦 ${product.short_desc.substring(0, 150)}` : '',
    '',
    HASHTAGS,
  ].filter(l => l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ─── ffmpeg composition ───────────────────────────────────────────────────────

async function compose(product, rawVideoPath) {
  const { w, h } = DIMENSIONS[FORMAT] || DIMENSIONS.reels;
  const filename   = `product_${product.id}_final.mp4`;
  const outputPath = path.join(OUTPUT_DIR, filename);
  const tmpPath    = path.join(OUTPUT_DIR, `product_${product.id}_tmp.mp4`);

  const priceText   = product.price_discount > 0
    ? `DE ${formatBRL(product.price_original)} POR ${formatBRL(product.price_discount)}`
    : formatBRL(product.price_original);
  const titleText   = product.name.substring(0, 45).toUpperCase();

  const hasWatermark = fileExists(WATERMARK_PATH);
  const hasMusic     = fileExists(MUSIC_PATH);

  // Filtro de escala base
  const baseVf = [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `setsar=1`,
    // Gradiente escuro na base para legibilidade do texto
    `drawbox=x=0:y=ih*0.65:w=iw:h=ih*0.4:color=black@0.6:t=fill`,
    // Nome do produto
    `drawtext=text='${titleText.replace(/[':]/g, ' ')}':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=h*0.70:shadowcolor=black@0.8:shadowx=2:shadowy=2`,
    // Preço
    `drawtext=text='${priceText.replace(/[':]/g, ' ')}':fontsize=40:fontcolor=yellow:x=(w-text_w)/2:y=h*0.81:shadowcolor=black@0.8:shadowx=2:shadowy=2`,
    // CTA
    `drawtext=text='VER OFERTA NA BIO':fontsize=34:fontcolor=white:x=(w-text_w)/2:y=h*0.90:box=1:boxcolor=red@0.85:boxborderw=14`,
  ].join(',');

  const args = ['-i', rawVideoPath];
  if (hasWatermark) args.push('-i', WATERMARK_PATH);
  if (hasMusic)     args.push('-stream_loop', '-1', '-i', MUSIC_PATH);

  if (hasWatermark) {
    args.push(
      '-filter_complex',
      `[0:v]${baseVf}[vbase];[vbase][1:v]overlay=W-w-16:H-h-16[vout]`,
      '-map', '[vout]',
    );
  } else {
    args.push('-vf', baseVf);
  }

  if (hasMusic) {
    const audioIdx = hasWatermark ? 2 : 1;
    args.push(
      '-map', `${audioIdx}:a`,
      '-af', `volume=0.25,afade=t=out:st=${Math.max(MAX_DURATION - 2, 1)}:d=2`,
    );
  }

  args.push(
    '-t',        String(MAX_DURATION),
    '-c:v',      'libx264',
    '-preset',   'fast',
    '-crf',      '23',
    '-c:a',      'aac',
    '-b:a',      '128k',
    '-movflags', '+faststart',
    '-pix_fmt',  'yuv420p',
    tmpPath,
  );

  log.info(`Renderizando [${product.id}] ${FORMAT} ${w}×${h}`);
  await ffmpeg(args);
  fs.renameSync(tmpPath, outputPath);
  log.info(`Vídeo composto: ${filename}`);

  const publicUrl = `${PUBLIC_BASE}/videos/${filename}`;
  return { localPath: outputPath, publicUrl };
}

// ─── Pipeline principal ───────────────────────────────────────────────────────

async function processProduct(product) {
  ensureDir(OUTPUT_DIR);

  const rawPath = path.join(OUTPUT_DIR, `product_${product.id}_raw.mp4`);
  const rawUrl  = product.video_raw_url;

  log.info(`Baixando vídeo bruto [${product.id}]`);
  await downloadFile(rawUrl, rawPath);

  const { localPath, publicUrl } = await compose(product, rawPath);
  const caption = buildCaption(product);

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

  fs.unlink(rawPath, () => {});
  log.info(`Produto [${product.id}] composto. URL pública: ${publicUrl}`);
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

module.exports = { run, processProduct, buildCaption };
