'use strict';

/**
 * MÓDULO 5 — Instagram Comment Auto-Responder
 *
 * Busca comentários novos nos posts publicados e responde
 * automaticamente com o link de afiliado rastreável.
 * Detecta intenção de compra/dúvida para responder de forma inteligente.
 */

const https = require('https');
const { query } = require('../db/database');
const { withRetry, sleep } = require('../utils/retry');
const { createLogger } = require('../utils/logger');

const log = createLogger('responder');

const ACCESS_TOKEN  = process.env.META_ACCESS_TOKEN;
const IG_ACCOUNT_ID = process.env.META_INSTAGRAM_ACCOUNT_ID;
const GRAPH_VER     = 'v21.0';
const BASE          = `https://graph.facebook.com/${GRAPH_VER}`;

// Palavras que indicam intenção de compra ou interesse
const BUY_INTENT_KEYWORDS = [
  'onde compra', 'onde comprar', 'link', 'quanto custa', 'preço', 'preco',
  'quero', 'comprar', 'como faz', 'como pede', 'loja', 'site',
  'kd', 'cadê', 'cade', 'manda o link', 'me manda', 'aonde',
  'comprei', 'compra', 'informação', 'info', 'tem', '?',
];

// Templates de resposta
const REPLY_TEMPLATES = [
  (link) => `Olá! 😊 Acesse o link na bio ou clique aqui: ${link} 🛍️`,
  (link) => `Oi! Link direto para comprar: ${link} 🔗✨`,
  (link) => `Claro! Você pode encontrar aqui 👉 ${link} #Shopee`,
  (link) => `Oi! Corre lá antes de acabar 🏃‍♀️💨 ${link}`,
  (link) => `Disponível aqui com desconto 🤩 ${link} 🛒`,
];

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function graphGet(endpoint, params = {}) {
  const qs = new URLSearchParams({ access_token: ACCESS_TOKEN, ...params });
  const url = `${BASE}${endpoint}?${qs}`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(`Graph: ${parsed.error.message}`));
          resolve(parsed);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function graphPost(endpoint, body) {
  const url = `${BASE}${endpoint}`;
  const payload = JSON.stringify({ access_token: ACCESS_TOKEN, ...body });
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(`Graph reply: ${parsed.error.message}`));
          resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Detecção de intenção ─────────────────────────────────────────────────────

function hasIntent(text) {
  const lower = (text || '').toLowerCase();
  return BUY_INTENT_KEYWORDS.some(kw => lower.includes(kw));
}

function pickReplyTemplate(link) {
  const idx = Math.floor(Math.random() * REPLY_TEMPLATES.length);
  return REPLY_TEMPLATES[idx](link);
}

// ─── Busca comentários ────────────────────────────────────────────────────────

async function fetchComments(mediaId) {
  const resp = await withRetry(
    () => graphGet(`/${mediaId}/comments`, {
      fields: 'id,text,username,timestamp',
      limit:  '50',
    }),
    { maxAttempts: 3, context: 'fetch-comments' }
  );
  return resp.data || [];
}

// ─── Resposta a comentário ────────────────────────────────────────────────────

async function replyToComment(commentId, message) {
  return withRetry(
    () => graphPost(`/${commentId}/replies`, { message }),
    { maxAttempts: 3, baseDelayMs: 2000, context: 'reply-comment' }
  );
}

// ─── Pipeline principal ───────────────────────────────────────────────────────

async function processMedia(mediaId, affiliateLink) {
  let comments;
  try {
    comments = await fetchComments(mediaId);
  } catch (err) {
    log.warn(`Erro ao buscar comentários de ${mediaId}`, { error: err.message });
    return 0;
  }

  let replied = 0;

  for (const comment of comments) {
    const { id: commentId, text, username } = comment;

    // Verifica se já processamos esse comentário
    const existing = await query(
      'SELECT id FROM instagram_comments WHERE comment_id = $1',
      [commentId]
    );

    // Salva o comentário independentemente de responder
    if (!existing.rows.length) {
      await query(
        `INSERT INTO instagram_comments (media_id, comment_id, username, text)
         VALUES ($1, $2, $3, $4) ON CONFLICT (comment_id) DO NOTHING`,
        [mediaId, commentId, username, text]
      );
    }

    if (existing.rows.length && existing.rows[0].replied) continue;

    // Responde se detecta intenção
    if (hasIntent(text)) {
      try {
        const replyText = pickReplyTemplate(affiliateLink);
        await replyToComment(commentId, replyText);

        await query(
          `UPDATE instagram_comments
              SET replied = TRUE, replied_at = NOW()
            WHERE comment_id = $1`,
          [commentId]
        );

        log.info(`Respondido @${username}`, { commentId, intent: text.substring(0, 50) });
        replied++;
        await sleep(2000); // respeita rate limit
      } catch (err) {
        log.error(`Erro ao responder ${commentId}`, { error: err.message });
      }
    }
  }

  return replied;
}

async function run() {
  log.info('Iniciando auto-responder de comentários...');

  if (!ACCESS_TOKEN || !IG_ACCOUNT_ID) {
    throw new Error('META_ACCESS_TOKEN ou META_INSTAGRAM_ACCOUNT_ID não configurados');
  }

  // Pega posts publicados das últimas 48h com link de afiliado
  const result = await query(
    `SELECT instagram_media_id, affiliate_link
       FROM products_queue
      WHERE status = 'published'
        AND instagram_media_id IS NOT NULL
        AND updated_at > NOW() - INTERVAL '48 hours'
      ORDER BY updated_at DESC`
  );

  log.info(`Posts a monitorar: ${result.rows.length}`);

  let totalReplied = 0;
  for (const row of result.rows) {
    const count = await processMedia(row.instagram_media_id, row.affiliate_link);
    totalReplied += count;
  }

  log.info(`Auto-responder concluído: ${totalReplied} respostas enviadas.`);
  return totalReplied;
}

module.exports = { run, processMedia, hasIntent };
