'use strict';

/**
 * Cliente leve para a API Anthropic (Claude).
 * Usado para gerar captions persuasivos por produto.
 * Não depende do SDK — chamada HTTPS direta.
 */

const https = require('https');
const { createLogger } = require('./logger');

const log = createLogger('llm');

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL   = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const BASE    = 'api.anthropic.com';

function callClaude({ system, user, maxTokens = 512 }) {
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY não configurado');

  const body = JSON.stringify({
    model:      MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: BASE,
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'Content-Length':    Buffer.byteLength(body),
        'x-api-key':         API_KEY,
        'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(`Claude API: ${parsed.error.message}`));
          const text = parsed.content?.[0]?.text || '';
          resolve(text.trim());
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Claude API timeout')); });
    req.write(body);
    req.end();
  });
}

module.exports = { callClaude };
