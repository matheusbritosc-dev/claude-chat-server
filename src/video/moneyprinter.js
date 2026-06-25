'use strict';

/**
 * Cliente para MoneyPrinterTurbo (auto-hospedado, gratuito)
 * GitHub: https://github.com/harry0703/MoneyPrinterTurbo
 *
 * Setup no VPS:
 *   git clone https://github.com/harry0703/MoneyPrinterTurbo
 *   cd MoneyPrinterTurbo
 *   cp config.example.toml config.toml
 *   # Edite config.toml: pexels_api_key, pixabay_api_key
 *   docker-compose up -d       # OU: pip install -r requirements.txt && python main.py
 *   # API sobe em http://localhost:8080
 *
 * Variáveis .env:
 *   MONEYPRINTER_BASE_URL=http://localhost:8080   (padrão)
 *   MONEYPRINTER_VIDEO_SOURCE=pexels              (pexels | pixabay | local)
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const { sleep } = require('../utils/retry');
const { createLogger } = require('../utils/logger');

const log = createLogger('moneyprinter');

const BASE_URL      = (process.env.MONEYPRINTER_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const VIDEO_SOURCE  = process.env.MONEYPRINTER_VIDEO_SOURCE || 'pexels';

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;

    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
    };

    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`MoneyPrinterTurbo HTTP ${res.statusCode}: ${data.substring(0, 300)}`));
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('MoneyPrinterTurbo timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    function doGet(u) {
      const lib = u.startsWith('https') ? https : http;
      lib.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return doGet(res.headers.location);
        if (res.statusCode >= 400) return reject(new Error(`Download HTTP ${res.statusCode}`));
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(dest); });
        file.on('error', reject);
      }).on('error', reject);
    }
    doGet(url);
  });
}

/**
 * Verifica se o MoneyPrinterTurbo está rodando.
 */
async function isAvailable() {
  try {
    await request('GET', `${BASE_URL}/api/v1/health`);
    return true;
  } catch {
    // Tenta também a rota raiz
    try {
      await request('GET', `${BASE_URL}/`);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Gera vídeo a partir de um assunto/produto.
 *
 * @param {object} opts
 * @param {string} opts.subject   - Nome/descrição do produto
 * @param {string} opts.language  - Idioma (padrão: pt)
 * @param {string} opts.destPath  - Onde salvar o MP4 resultante
 * @returns {Promise<string>}     - Path do vídeo gerado
 */
async function generateVideo({ subject, language = 'pt', destPath }) {
  log.info(`MoneyPrinterTurbo: gerando vídeo para "${subject.substring(0, 60)}"`);

  const body = {
    video_subject:       subject,
    video_language:      language,
    voice_name:          process.env.TTS_VOICE || 'pt-BR-FranciscaNeural',
    video_source:        VIDEO_SOURCE,
    video_aspect:        '9:16',
    video_count:         1,
    video_clip_duration: 5,
    video_concat_mode:   'random',
    subtitle_enabled:    false,
    // Usa apenas o vídeo (sem narração embutida) para que nosso composer adicione a voz clonada
    voice_volume:        0,
  };

  const resp = await request('POST', `${BASE_URL}/api/v1/videos`, body);
  const taskId = resp?.task_id || resp?.id;
  if (!taskId) throw new Error(`MoneyPrinterTurbo sem task_id: ${JSON.stringify(resp)}`);
  log.info(`Task criada: ${taskId}`);

  // Polling até concluir (timeout 10 min)
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    await sleep(10000);
    const status = await request('GET', `${BASE_URL}/api/v1/tasks/${taskId}`);

    // state: 1=processando, 2=concluído, -1=falhou
    const state = status?.state ?? status?.status;
    log.debug(`Task ${taskId}: state=${state}`);

    if (state === 2 || state === 'completed' || state === 'success') {
      // Pega o primeiro vídeo gerado
      const videos = status?.videos || status?.output?.videos || [];
      if (!videos.length) throw new Error('MoneyPrinterTurbo concluiu mas sem vídeos');

      const videoPath = videos[0];

      // Se for URL remota, baixa; se for path local no servidor, copia via /files/
      if (videoPath.startsWith('http')) {
        await downloadFile(videoPath, destPath);
      } else {
        // Tenta baixar via endpoint de arquivos
        const filename = videoPath.split('/').pop();
        await downloadFile(`${BASE_URL}/api/v1/files/${taskId}/${filename}`, destPath);
      }

      log.info(`Vídeo MoneyPrinterTurbo salvo: ${destPath}`);
      return destPath;
    }

    if (state === -1 || state === 'failed' || state === 'error') {
      throw new Error(`MoneyPrinterTurbo task ${taskId} falhou: ${status?.message || 'desconhecido'}`);
    }
  }

  throw new Error(`MoneyPrinterTurbo timeout aguardando task ${taskId}`);
}

module.exports = { generateVideo, isAvailable };
