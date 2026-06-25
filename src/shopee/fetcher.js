'use strict';

/**
 * MÓDULO 1 — Shopee Product Fetcher
 *
 * Busca novos lançamentos/produtos em alta na Shopee Afiliados BR,
 * gera links de afiliado rastreáveis e persiste na fila do banco.
 */

const https = require('https');
const { URL } = require('url');
const { buildAuthParams } = require('./auth');
const { query } = require('../db/database');
const { withRetry } = require('../utils/retry');
const { createLogger } = require('../utils/logger');

const log = createLogger('shopee-fetcher');

const APP_ID      = process.env.SHOPEE_APP_ID;
const APP_SECRET  = process.env.SHOPEE_APP_SECRET;
const ACCESS_TOKEN = process.env.SHOPEE_ACCESS_TOKEN;
const BASE_URL    = process.env.SHOPEE_BASE_URL || 'https://open-api.affiliate.shopee.com.br';
const MIN_COMMISSION = parseFloat(process.env.SHOPEE_MIN_COMMISSION || '8');
const MAX_PRODUCTS   = parseInt(process.env.SHOPEE_MAX_PRODUCTS_PER_RUN || '10');
const CATEGORY_IDS   = process.env.SHOPEE_CATEGORY_IDS
  ? process.env.SHOPEE_CATEGORY_IDS.split(',').map(s => s.trim())
  : [];

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Shopee API calls ─────────────────────────────────────────────────────────

async function fetchNewProducts({ page = 1, pageSize = 50 } = {}) {
  const path = '/open/api/v1/product/get_dts_list';
  const auth = buildAuthParams({ appId: APP_ID, appSecret: APP_SECRET, accessToken: ACCESS_TOKEN, path });

  const qs = new URLSearchParams({
    ...auth,
    page: String(page),
    page_size: String(pageSize),
    sort_type: '2',        // 1=populares, 2=novos lançamentos, 3=mais vendidos
    ...(CATEGORY_IDS.length ? { category_id: CATEGORY_IDS[0] } : {}),
  });

  const url = `${BASE_URL}${path}?${qs}`;
  log.debug('GET produtos', { url: url.substring(0, 120) });

  const resp = await withRetry(() => httpsGet(url), { maxAttempts: 3, context: 'shopee-products' });

  if (resp.code !== 0) {
    throw new Error(`Shopee API erro: ${resp.code} — ${resp.message}`);
  }
  return resp.data?.product_list || [];
}

async function generateAffiliateLink(productUrl) {
  const path = '/open/api/v1/link/generate';
  const auth = buildAuthParams({ appId: APP_ID, appSecret: APP_SECRET, accessToken: ACCESS_TOKEN, path });

  const qs = new URLSearchParams({
    ...auth,
    origin_url: productUrl,
    sub_ids: 'ig_auto',   // rastreamento customizado
  });

  const url = `${BASE_URL}${path}?${qs}`;
  const resp = await withRetry(() => httpsGet(url), { maxAttempts: 3, context: 'affiliate-link' });

  if (resp.code !== 0) {
    throw new Error(`Shopee link API erro: ${resp.code} — ${resp.message}`);
  }
  return resp.data?.generate_link_list?.[0]?.short_link || productUrl;
}

// ─── Normalização ─────────────────────────────────────────────────────────────

function normalizeProduct(raw) {
  const commission = parseFloat(raw.commission_rate || raw.commission || '0');
  return {
    shopee_id:       String(raw.product_id || raw.item_id),
    name:            raw.product_name || raw.item_name || 'Produto Shopee',
    image_url:       raw.product_image || raw.image || null,
    price_original:  parseFloat(raw.price_max || raw.price || '0') / 100000,
    price_discount:  parseFloat(raw.sale_price || raw.price_min || '0') / 100000,
    commission_pct:  commission,
    short_desc:      (raw.description || '').substring(0, 200),
    product_url:     raw.product_url || raw.product_link || '',
  };
}

// ─── Persistência ─────────────────────────────────────────────────────────────

async function saveToQueue(product) {
  const sql = `
    INSERT INTO products_queue
      (shopee_id, name, image_url, price_original, price_discount,
       commission_pct, affiliate_link, short_desc, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
    ON CONFLICT (shopee_id) DO NOTHING
    RETURNING id
  `;
  const result = await query(sql, [
    product.shopee_id,
    product.name,
    product.image_url,
    product.price_original,
    product.price_discount,
    product.commission_pct,
    product.affiliate_link,
    product.short_desc,
  ]);
  return result.rows[0]?.id || null;
}

// ─── Pipeline principal ───────────────────────────────────────────────────────

async function run() {
  log.info('Iniciando busca de produtos Shopee...');

  if (!APP_ID || !APP_SECRET || !ACCESS_TOKEN) {
    throw new Error('Credenciais Shopee não configuradas (SHOPEE_APP_ID, SHOPEE_APP_SECRET, SHOPEE_ACCESS_TOKEN)');
  }

  const rawProducts = await fetchNewProducts({ pageSize: MAX_PRODUCTS * 3 });
  log.info(`Produtos brutos recebidos: ${rawProducts.length}`);

  const filtered = rawProducts
    .map(normalizeProduct)
    .filter(p => p.commission_pct >= MIN_COMMISSION && p.image_url && p.product_url);

  log.info(`Após filtros (comissão >= ${MIN_COMMISSION}%): ${filtered.length}`);

  const toProcess = filtered.slice(0, MAX_PRODUCTS);
  let saved = 0;

  for (const product of toProcess) {
    try {
      product.affiliate_link = await generateAffiliateLink(product.product_url);
      const id = await saveToQueue(product);
      if (id) {
        saved++;
        log.info(`Salvo: [${id}] ${product.name.substring(0, 50)} — ${product.commission_pct}%`);
      } else {
        log.debug(`Já existe na fila: ${product.shopee_id}`);
      }
    } catch (err) {
      log.error(`Erro ao processar ${product.shopee_id}`, { error: err.message });
    }
  }

  log.info(`Fetcher concluído: ${saved} novos produtos na fila.`);
  return saved;
}

module.exports = { run, fetchNewProducts, generateAffiliateLink, normalizeProduct };
