'use strict';

/**
 * Cliente Meta compartilhado (publisher / stories / responder)
 *
 * Detecta automaticamente qual API usar a partir do prefixo do token:
 *
 *  - Token "IGAA..."  → Instagram API com Login do Instagram
 *                       host: graph.instagram.com
 *                       O id da conta pode ser "me" (alias do próprio usuário).
 *
 *  - Token "EAA..."   → Facebook Login (Graph API clássica)
 *                       host: graph.facebook.com
 *                       Exige META_INSTAGRAM_ACCOUNT_ID (id numérico da conta business).
 *
 * Permite sobrescrever o host com META_API_HOST se necessário.
 */

const https = require('https');

const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const GRAPH_VER    = process.env.META_GRAPH_VERSION || 'v21.0';

// Instagram Login token começa com "IG"; Facebook Login com "EAA".
const IS_IG_LOGIN = ACCESS_TOKEN.startsWith('IG');

const HOST = process.env.META_API_HOST
  || (IS_IG_LOGIN ? 'graph.instagram.com' : 'graph.facebook.com');

const BASE = `https://${HOST}/${GRAPH_VER}`;

// Para Instagram Login, "me" funciona como id da própria conta nos endpoints
// de publicação. Para Facebook Login é obrigatório o id numérico.
const ACCOUNT_ID = process.env.META_INSTAGRAM_ACCOUNT_ID
  || (IS_IG_LOGIN ? 'me' : '');

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function graphGet(endpoint, params = {}) {
  const qs  = new URLSearchParams({ access_token: ACCESS_TOKEN, ...params });
  const url = `${BASE}${endpoint}?${qs}`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(`Graph API [${res.statusCode}]: ${parsed.error.message} (code ${parsed.error.code})`));
          resolve(parsed);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function graphPost(endpoint, body) {
  const payload = JSON.stringify({ access_token: ACCESS_TOKEN, ...body });
  return new Promise((resolve, reject) => {
    const req = https.request(`${BASE}${endpoint}`, {
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(`Graph API [${res.statusCode}]: ${parsed.error.message} (code ${parsed.error.code})`));
          resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Validação de token ───────────────────────────────────────────────────────

async function validateToken() {
  // graph.instagram.com expõe "username"; graph.facebook.com expõe "name".
  const fields = IS_IG_LOGIN ? 'id,username' : 'id,name';
  const resp = await graphGet('/me', { fields });
  return resp;
}

module.exports = {
  graphGet,
  graphPost,
  validateToken,
  ACCESS_TOKEN,
  ACCOUNT_ID,
  BASE,
  HOST,
  IS_IG_LOGIN,
};
