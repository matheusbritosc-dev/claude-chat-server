'use strict';

/**
 * MÓDULO 3 — Video Editor / Post Composer
 *
 * Para cada produto com status 'video_ready':
 *  a) Baixa o vídeo gerado pelo Higgsfield
 *  b) Adiciona overlay de texto (nome + preço antes/depois)
 *  c) Adiciona watermark/logo no canto inferior
 *  d) Adiciona música de fundo em loop
 *  e) Formata para Instagram: 9:16 (1080x1920) Reels ou 1:1 feed
 *  f) Garante duração máxima de 30s
 *  g) Gera legenda com hashtags e CTA
 *  h) Atualiza status para 'composed'
 */

const { execFile } = require('child_process');
const fs  = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');
const { query } = require('../db/database');
const { createLogger } = require('../utils/logger');

const log = createLogger('editor');

const FORMAT          = process.env.VIDEO_FORMAT      || 'reels';  // reels | feed
const MAX_DURATION    = parseInt(process.env.VIDEO_DURATION_MAX || '30');
const WATERMARK_PATH  = process.env.WATERMARK_PATH    || path.join(__dirname, '../../assets/logo.png');
const MUSIC_PATH      = process.env.MUSIC_PATH        || path.join(__dirname, '../../assets/music/bg.mp3');
const HASHTAGS        = process.env.AFFILIATE_HASHTAGS || '#shopee #oferta #promocao #comprinhas';
const CTA             = process.env.AFFILIATE_CTA      || '🔗 Link na bio!';
const OUTPUT_DIR      = path.join(__dirname, '../../tmp/videos');

const DIMENSIONS = {
  reels: { w: 1080, h: 1920 },
  feed:  { w: 1080, h: 1080 },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    const req = lib.get(url, (res) => {
      if (res.statusCode >= 400) {
        return reject(new Error(`Download falhou: HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
    });
    req.on('error', (err) => { fs.unlink(dest, () => {}); reject(err); });
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', ...args], { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        log.error('ffmpeg erro', { args: args.slice(0, 5).join(' '), stderr: stderr.substring(0, 300) });
        return reject(new Error(`ffmpeg: ${err.message}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// ─── Formatador de preço BR ───────────────────────────────────────────────────

function formatBRL(value) {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// ─── Geração de legenda ───────────────────────────────────────────────────────

function buildCaption(product) {
  const discount = product.price_original > 0
    ? Math.round((1 - product.price_discount / product.price_original) * 100)
    : 0;

  const lines = [
    `🛍️ ${product.name}`,
    '',
    discount > 0
      ? `✂️ De ${formatBRL(product.price_original)} por apenas ${formatBRL(product.price_discount)} (${discount}% OFF!)`
      : `💰 Por apenas ${formatBRL(product.price_discount)}`,
    '',
    product.commission_pct > 0 ? `⭐ Comissão para você: ${product.commission_pct}%` : '',
    '',
    CTA,
    '',
    product.short_desc ? `📦 ${product.short_desc.substring(0, 120)}` : '',
    '',
    HASHTAGS,
  ].filter(l => l !== undefined);

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ─── Filtros ffmpeg ───────────────────────────────────────────────────────────

async function compose(product, rawVideoPath) {
  const { w, h } = DIMENSIONS[FORMAT] || DIMENSIONS.reels;
  const outputPath = path.join(OUTPUT_DIR, `product_${product.id}_final.mp4`);
  const tmpPath    = path.join(OUTPUT_DIR, `product_${product.id}_tmp.mp4`);

  const priceText = product.price_discount > 0
    ? `DE ${formatBRL(product.price_original)} POR ${formatBRL(product.price_discount)}`
    : formatBRL(product.price_original);

  const productTitle = product.name.substring(0, 50).toUpperCase();

  // Filtro de vídeo base: escala + padding para o formato correto
  let vf = [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `setsar=1`,
  ].join(',');

  // Overlay de texto — nome do produto
  vf += `,drawtext=text='${productTitle.replace(/'/g, "\\'")}':` +
    `fontsize=52:fontcolor=white:x=(w-text_w)/2:y=h*0.72:` +
    `shadowcolor=black:shadowx=3:shadowy=3:` +
    `box=1:boxcolor=black@0.5:boxborderw=12`;

  // Overlay de preço
  vf += `,drawtext=text='${priceText.replace(/'/g, "\\'")}':` +
    `fontsize=42:fontcolor=yellow:x=(w-text_w)/2:y=h*0.82:` +
    `shadowcolor=black:shadowx=2:shadowy=2:` +
    `box=1:boxcolor=black@0.6:boxborderw=10`;

  // Watermark / logo (se arquivo existir)
  const hasWatermark = fileExists(WATERMARK_PATH);
  const hasMusic     = fileExists(MUSIC_PATH);

  // Monta o comando ffmpeg base
  const args = [
    '-i', rawVideoPath,
  ];

  if (hasWatermark) {
    args.push('-i', WATERMARK_PATH);
  }

  if (hasMusic) {
    args.push('-stream_loop', '-1', '-i', MUSIC_PATH);
  }

  // Complexo filter graph quando há watermark
  let filterComplex = '';
  if (hasWatermark) {
    filterComplex = `[0:v]${vf}[vbase];[vbase][1:v]overlay=W-w-20:H-h-20[vout]`;
    args.push('-filter_complex', filterComplex, '-map', '[vout]');
  } else {
    args.push('-vf', vf);
  }

  // Áudio
  if (hasMusic) {
    const audioIdx = hasWatermark ? 2 : 1;
    // Mistura áudio original (se existir) com música, priorizando música
    args.push(
      '-map', `${audioIdx}:a`,
      '-af', `volume=0.3,afade=t=out:st=${MAX_DURATION - 2}:d=2`,
    );
  }

  // Codec e formato final
  args.push(
    '-t', String(MAX_DURATION),
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-pix_fmt', 'yuv420p',
    tmpPath,
  );

  log.info(`Renderizando vídeo produto [${product.id}]`, { format: FORMAT, w, h });
  await ffmpeg(args);

  fs.renameSync(tmpPath, outputPath);
  log.info(`Vídeo composto: ${outputPath}`);
  return outputPath;
}

// ─── Pipeline principal ───────────────────────────────────────────────────────

async function processProduct(product) {
  ensureDir(OUTPUT_DIR);

  const rawPath = path.join(OUTPUT_DIR, `product_${product.id}_raw.mp4`);

  log.info(`Baixando vídeo [${product.id}]`, { url: product.video_url.substring(0, 80) });
  await downloadFile(product.video_url, rawPath);

  const finalPath = await compose(product, rawPath);
  const caption   = buildCaption(product);

  // Persiste paths e legenda
  await query(
    `UPDATE products_queue
        SET status      = 'composed',
            video_url   = $1,
            short_desc  = $2,
            updated_at  = NOW()
      WHERE id = $3`,
    [finalPath, caption, product.id]
  );

  // Remove raw para economizar espaço
  fs.unlink(rawPath, () => {});

  return { videoPath: finalPath, caption };
}

async function run() {
  log.info('Iniciando editor / composer...');

  const result = await query(
    `SELECT * FROM products_queue
      WHERE status = 'video_ready'
      ORDER BY created_at ASC
      LIMIT 5`
  );

  const products = result.rows;
  log.info(`Produtos prontos para composição: ${products.length}`);

  for (const product of products) {
    try {
      await processProduct(product);
    } catch (err) {
      log.error(`Falha ao compor produto [${product.id}]`, { error: err.message });
      await query(
        `UPDATE products_queue
            SET status    = 'compose_failed',
                error_msg = $1,
                updated_at = NOW()
          WHERE id = $2`,
        [err.message.substring(0, 500), product.id]
      );
    }
  }

  log.info('Composer concluído.');
}

module.exports = { run, processProduct, buildCaption };
