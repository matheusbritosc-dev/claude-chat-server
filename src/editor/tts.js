'use strict';

/**
 * Text-to-Speech via Edge TTS (Microsoft, 100% gratuito).
 * Implementação inspirada no MoneyPrinterTurbo.
 *
 * Requer: pip install edge-tts  (Python 3.x)
 * Vozes pt-BR disponíveis:
 *   pt-BR-FranciscaNeural  — feminina, natural (padrão)
 *   pt-BR-AntonioNeural    — masculina, natural
 *   pt-BR-ThalitaNeural    — feminina, expressiva
 *
 * Uso: const { generateTTS } = require('./tts');
 *      const audioPath = await generateTTS({ text: '...', outputPath: '/tmp/narr.mp3' });
 */

const { execFile, exec } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { createLogger } = require('../utils/logger');

const log = createLogger('tts');

const VOICE      = process.env.TTS_VOICE   || 'pt-BR-FranciscaNeural';
const TTS_RATE   = process.env.TTS_RATE    || '+10%';   // velocidade (+10% = levemente mais rápido)
const TTS_VOLUME = process.env.TTS_VOLUME  || '+0%';
const ENABLED    = process.env.TTS_ENABLED !== 'false'; // true por padrão

// ─── Verificação de disponibilidade ──────────────────────────────────────────

let _edgeTtsAvailable = null;

async function isEdgeTtsAvailable() {
  if (_edgeTtsAvailable !== null) return _edgeTtsAvailable;
  return new Promise(resolve => {
    exec('edge-tts --version', (err) => {
      _edgeTtsAvailable = !err;
      if (!_edgeTtsAvailable) {
        log.warn('edge-tts não encontrado. Instale com: pip install edge-tts');
      }
      resolve(_edgeTtsAvailable);
    });
  });
}

// ─── Geração de áudio ─────────────────────────────────────────────────────────

/**
 * Gera narração MP3 a partir de texto.
 * @param {object} opts
 * @param {string} opts.text        - Texto a narrar
 * @param {string} opts.outputPath  - Caminho do arquivo .mp3 de saída
 * @param {string} [opts.voice]     - Voz Edge TTS (override)
 * @returns {Promise<string|null>}  - Path do arquivo gerado ou null se falhar
 */
async function generateTTS({ text, outputPath, voice }) {
  if (!ENABLED) return null;

  const available = await isEdgeTtsAvailable();
  if (!available) return null;

  const selectedVoice = voice || VOICE;
  const cleanText = text
    .replace(/[#*_~`]/g, '')   // remove markdown
    .replace(/https?:\/\/\S+/g, '')  // remove URLs
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 500);  // Edge TTS tem limite prático de ~500 chars por chamada

  if (!cleanText) return null;

  return new Promise((resolve) => {
    const args = [
      '--voice',  selectedVoice,
      '--text',   cleanText,
      '--rate',   TTS_RATE,
      '--volume', TTS_VOLUME,
      '--write-media', outputPath,
    ];

    log.debug(`Gerando TTS: "${cleanText.substring(0, 60)}..." → ${path.basename(outputPath)}`);

    execFile('edge-tts', args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        log.warn('edge-tts falhou', { error: err.message, stderr: stderr?.substring(0, 200) });
        return resolve(null);
      }
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
        log.warn('edge-tts gerou arquivo vazio');
        return resolve(null);
      }
      log.info(`TTS gerado: ${path.basename(outputPath)} (${fs.statSync(outputPath).size} bytes)`);
      resolve(outputPath);
    });
  });
}

/**
 * Retorna a duração em segundos de um arquivo de áudio via ffprobe.
 */
function getAudioDuration(filePath) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(null);
      const dur = parseFloat(stdout.trim());
      resolve(isNaN(dur) ? null : dur);
    });
  });
}

module.exports = { generateTTS, getAudioDuration, isEdgeTtsAvailable };
