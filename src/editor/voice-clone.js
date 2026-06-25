'use strict';

/**
 * Clone de voz via GPT-SoVITS (github.com/RVC-Boss/GPT-SoVITS)
 *
 * GPT-SoVITS roda como servidor Python local na porta 9880.
 * Com apenas 5-30s de áudio de referência (sua voz) já é possível
 * sintetizar qualquer texto com a voz clonada.
 *
 * Setup no VPS:
 *   conda create -n GPTSoVits python=3.10 && conda activate GPTSoVits
 *   bash install.sh --device CPU   # ou CU126 para GPU NVIDIA
 *   python api_v2.py -a 0.0.0.0 -p 9880
 *
 * Arquivo de referência: assets/voice/reference.wav (mínimo 5s, ideal 30s)
 *
 * Fallback chain: GPT-SoVITS → Edge TTS → template silencioso
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { createLogger } = require('../utils/logger');
const { generateTTS }  = require('./tts');

const log = createLogger('voice-clone');

const GPTSO_BASE = (process.env.GPTSO_BASE_URL || 'http://localhost:9880').replace(/\/$/, '');
const REF_AUDIO  = process.env.VOICE_REFERENCE_PATH
  || path.join(__dirname, '../../assets/voice/reference.wav');
const REF_TEXT   = process.env.VOICE_REFERENCE_TEXT || '';    // transcrição do ref audio (opcional)
const REF_LANG   = process.env.VOICE_REFERENCE_LANG || 'pt';  // idioma do ref audio
const TEXT_LANG  = process.env.VOICE_TEXT_LANG      || 'pt';
const ENABLED    = process.env.VOICE_CLONE_ENABLED  !== 'false';

// ─── Verificação de disponibilidade ──────────────────────────────────────────

let _available = null;

async function isAvailable() {
  if (_available !== null) return _available;
  return new Promise((resolve) => {
    const url = new URL(`${GPTSO_BASE}/`);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(`${GPTSO_BASE}/`, { timeout: 3000 }, (res) => {
      _available = res.statusCode < 500;
      resolve(_available);
    });
    req.on('error', () => { _available = false; resolve(false); });
    req.on('timeout', () => { req.destroy(); _available = false; resolve(false); });
  });
}

// ─── Geração com voz clonada ──────────────────────────────────────────────────

/**
 * Gera áudio com a voz clonada via GPT-SoVITS.
 * @param {string} text       - Texto a narrar (máx ~200 chars por chamada)
 * @param {string} outputPath - Onde salvar o .wav/.mp3 gerado
 * @returns {Promise<string|null>} Path do arquivo gerado ou null se falhar
 */
async function generateClonedVoice(text, outputPath) {
  if (!ENABLED) return null;
  if (!fs.existsSync(REF_AUDIO)) {
    log.warn('Arquivo de voz de referência não encontrado', { path: REF_AUDIO });
    log.warn('Coloque um áudio de 5-30s da sua voz em: assets/voice/reference.wav');
    return null;
  }

  const available = await isAvailable();
  if (!available) {
    log.warn('GPT-SoVITS não acessível em ' + GPTSO_BASE);
    return null;
  }

  // GPT-SoVITS aceita referência via path local (server-side)
  const body = JSON.stringify({
    text,
    text_lang:       TEXT_LANG,
    ref_audio_path:  REF_AUDIO,
    prompt_lang:     REF_LANG,
    prompt_text:     REF_TEXT || '',
    media_type:      'wav',
    streaming_mode:  false,
    speed_factor:    1.05,   // levemente mais rápido — soa mais dinâmico
    top_k:           15,
    top_p:           1.0,
    temperature:     1.0,
  });

  return new Promise((resolve) => {
    const url = new URL(`${GPTSO_BASE}/tts`);
    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request(`${GPTSO_BASE}/tts`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      if (res.statusCode >= 400) {
        log.warn(`GPT-SoVITS retornou ${res.statusCode}`);
        res.resume();
        return resolve(null);
      }

      const file = fs.createWriteStream(outputPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        const size = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
        if (size < 1000) {
          log.warn('GPT-SoVITS gerou arquivo de áudio vazio/muito pequeno');
          fs.unlink(outputPath, () => {});
          return resolve(null);
        }
        log.info(`Voz clonada gerada: ${path.basename(outputPath)} (${(size/1024).toFixed(1)}KB)`);
        resolve(outputPath);
      });
      file.on('error', () => resolve(null));
    });

    req.on('error', (err) => {
      log.warn('Erro GPT-SoVITS', { error: err.message });
      resolve(null);
    });
    req.setTimeout(60000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ─── Interface pública com fallback automático ────────────────────────────────

/**
 * Gera áudio de narração usando a melhor opção disponível:
 * 1º GPT-SoVITS (voz clonada) → 2º Edge TTS → null
 */
async function generateNarration(text, outputPath) {
  // Tenta voz clonada primeiro
  const cloned = await generateClonedVoice(text, outputPath).catch(() => null);
  if (cloned) return { path: cloned, source: 'voice-clone' };

  // Fallback: Edge TTS
  const edgePath = outputPath.replace(/\.wav$/, '_edge.mp3');
  const edged = await generateTTS({ text, outputPath: edgePath }).catch(() => null);
  if (edged) return { path: edged, source: 'edge-tts' };

  return null;
}

/**
 * Configura o áudio de referência sem fazer inferência.
 * Útil para pre-warm o servidor GPT-SoVITS.
 */
async function setReferenceAudio(refPath) {
  const available = await isAvailable();
  if (!available) return false;

  return new Promise((resolve) => {
    const url = `${GPTSO_BASE}/set_refer_audio?refer_audio_path=${encodeURIComponent(refPath)}`;
    const lib = url.startsWith('https') ? https : http;
    http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode < 400);
    }).on('error', () => resolve(false));
  });
}

module.exports = { generateNarration, generateClonedVoice, isAvailable, setReferenceAudio };
