'use strict';

const { Pool } = require('pg');
const { createLogger } = require('../utils/logger');

const log = createLogger('db');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME     || 'shopee_automation',
      user:     process.env.DB_USER     || 'shopee_bot',
      password: process.env.DB_PASSWORD,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => log.error('Pool error', { error: err.message }));
  }
  return pool;
}

async function query(sql, params) {
  const client = await getPool().connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

async function migrate() {
  log.info('Rodando migrations...');
  await query(`
    CREATE TABLE IF NOT EXISTS products_queue (
      id                  SERIAL PRIMARY KEY,
      shopee_id           VARCHAR(64) UNIQUE NOT NULL,
      name                TEXT NOT NULL,
      image_url           TEXT,
      price_original      NUMERIC(12,2),
      price_discount      NUMERIC(12,2),
      commission_pct      NUMERIC(5,2),
      affiliate_link      TEXT,
      short_desc          TEXT,
      caption             TEXT,
      status              VARCHAR(32) DEFAULT 'pending',
      higgsfield_job_id   TEXT,
      video_raw_url       TEXT,
      video_local_path    TEXT,
      video_public_url    TEXT,
      instagram_media_id  TEXT,
      instagram_post_url  TEXT,
      error_msg           TEXT,
      attempt_count       INT DEFAULT 0,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Migração incremental: adiciona colunas novas se tabela já existia
  const newCols = [
    [`caption`,           `TEXT`],
    [`higgsfield_job_id`, `TEXT`],
    [`video_raw_url`,     `TEXT`],
    [`video_local_path`,  `TEXT`],
    [`video_public_url`,  `TEXT`],
  ];
  for (const [col, type] of newCols) {
    await query(`ALTER TABLE products_queue ADD COLUMN IF NOT EXISTS ${col} ${type}`).catch(() => {});
  }

  await query(`
    CREATE TABLE IF NOT EXISTS instagram_comments (
      id          SERIAL PRIMARY KEY,
      media_id    VARCHAR(64),
      comment_id  VARCHAR(64) UNIQUE NOT NULL,
      username    VARCHAR(128),
      text        TEXT,
      replied     BOOLEAN DEFAULT FALSE,
      replied_at  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_products_status ON products_queue(status)`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_products_created ON products_queue(created_at DESC)`).catch(() => {});
  await query(`CREATE INDEX IF NOT EXISTS idx_comments_media ON instagram_comments(media_id)`).catch(() => {});

  log.info('Migrations concluídas.');
}

async function close() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = { query, migrate, close, getPool };
