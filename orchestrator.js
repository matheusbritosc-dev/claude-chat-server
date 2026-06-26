'use strict';

require('dotenv').config();

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { createWebhookMiddleware } = require('./src/webhook/server');
const { migrate, close, query }   = require('./src/db/database');
const { createLogger }            = require('./src/utils/logger');

const log  = createLogger('orchestrator');
const PORT = parseInt(process.env.PORT || '3457');

const VIDEOS_DIR = path.join(__dirname, 'tmp/videos');

// ─── Pipeline ─────────────────────────────────────────────────────────────────

async function runPipeline(step) {
  const steps = {
    fetch:    () => require('./src/shopee/fetcher').run(),
    generate: () => require('./src/higgsfield/generator').run(),
    compose:  () => require('./src/editor/composer').run(),
    publish:  () => require('./src/instagram/publisher').run(),
    stories:  () => require('./src/instagram/stories').run(),
    respond:  () => require('./src/instagram/responder').run(),
  };

  if (step === 'full') {
    log.info('=== PIPELINE COMPLETO ===');
    for (const s of ['fetch', 'generate', 'compose', 'publish', 'stories', 'respond']) {
      log.info(`-- ${s} --`);
      await steps[s]();
    }
    log.info('=== PIPELINE CONCLUÍDO ===');
    return;
  }

  if (!steps[step]) throw new Error(`Etapa desconhecida: ${step}`);
  return steps[step]();
}

// ─── Status ───────────────────────────────────────────────────────────────────

async function getStatus() {
  const res = await query(
    `SELECT status, COUNT(*) as count FROM products_queue GROUP BY status ORDER BY status`
  );
  const queue = {};
  for (const r of res.rows) queue[r.status] = parseInt(r.count);

  const recent = await query(
    `SELECT id, name, status, commission_pct, instagram_post_url, updated_at
       FROM products_queue ORDER BY updated_at DESC LIMIT 10`
  );

  return { uptime: Math.round(process.uptime()), pid: process.pid, queue, recent: recent.rows };
}

// ─── Servidor estático de vídeos ─────────────────────────────────────────────

function serveVideo(req, res) {
  const filename = path.basename(req.url.split('?')[0]);
  // Permite .mp4, .mp3, .wav — sem path traversal
  const extMatch = filename.match(/\.(mp4|mp3|wav)$/i);
  if (!/^[\w-]+\.(mp4|mp3|wav)$/i.test(filename)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  const filePath = path.join(VIDEOS_DIR, filename);
  if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('Not Found'); }

  const ext = (extMatch && extMatch[1].toLowerCase()) || 'mp4';
  const mimeTypes = { mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav' };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  const stat = fs.statSync(filePath);
  const range = req.headers.range;

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr);
    const end   = endStr ? parseInt(endStr) : stat.size - 1;
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': end - start + 1,
      'Content-Type':   contentType,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type':   contentType,
      'Accept-Ranges':  'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

// ─── Dashboard HTML ───────────────────────────────────────────────────────────

function sendDashboard(res) {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Shopee × Instagram Automation</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#e5e5e5;padding:24px}
    h1{color:#ff6b35;margin-bottom:8px;font-size:1.4rem}
    p.sub{color:#888;margin-bottom:28px;font-size:.85rem}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:28px}
    .card{background:#1a1a1a;border-radius:10px;padding:16px;text-align:center}
    .card .n{font-size:2.2rem;font-weight:700;color:#ff6b35}
    .card .l{font-size:.75rem;color:#888;margin-top:4px;text-transform:uppercase}
    table{width:100%;border-collapse:collapse;font-size:.82rem;background:#1a1a1a;border-radius:10px;overflow:hidden}
    th{background:#242424;padding:10px 12px;text-align:left;color:#888;font-weight:500}
    td{padding:10px 12px;border-top:1px solid #2a2a2a}
    .badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:.72rem;font-weight:600}
    .badge.published{background:#16a34a22;color:#4ade80}
    .badge.pending{background:#78350f22;color:#fbbf24}
    .badge.composed{background:#1d4ed822;color:#60a5fa}
    .badge.failed{background:#7f1d1d22;color:#f87171}
    .badge.generating,.badge.video_ready,.badge.awaiting_webhook{background:#5b21b622;color:#c084fc}
    .btns{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:28px}
    button{padding:10px 20px;border:none;border-radius:8px;background:#ff6b35;color:#fff;cursor:pointer;font-weight:600;font-size:.85rem}
    button:hover{background:#e85e2b}
    button.secondary{background:#242424;color:#e5e5e5}
    button.secondary:hover{background:#333}
    .add-form{background:#1a1a1a;border-radius:10px;padding:20px;margin-bottom:28px}
    .add-form h2{font-size:.95rem;color:#ff6b35;margin-bottom:14px}
    .add-form .row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
    .add-form .row.full{grid-template-columns:1fr}
    .add-form input{background:#0f0f0f;border:1px solid #333;border-radius:6px;padding:8px 12px;color:#e5e5e5;font-size:.82rem;width:100%}
    .add-form input::placeholder{color:#555}
    .add-form button{margin-top:6px;width:100%;background:#ff6b35}
    #add-result{font-size:.8rem;margin-top:8px;padding:6px 10px;border-radius:6px;display:none}
    #add-result.ok{background:#16a34a22;color:#4ade80}
    #add-result.err{background:#7f1d1d22;color:#f87171}
    #log{background:#0a0a0a;border-radius:8px;padding:12px;font-family:monospace;font-size:.78rem;height:160px;overflow-y:auto;color:#4ade80;margin-top:20px;display:none}
    a{color:#60a5fa;text-decoration:none}
    a:hover{text-decoration:underline}
  </style>
</head>
<body>
  <h1>🚀 Shopee × Instagram Automation</h1>
  <p class="sub">Dashboard de controle — atualiza automaticamente a cada 30s</p>

  <div id="cards" class="grid">
    <div class="card"><div class="n" id="n-pending">…</div><div class="l">Pendentes</div></div>
    <div class="card"><div class="n" id="n-video">…</div><div class="l">Vídeos prontos</div></div>
    <div class="card"><div class="n" id="n-composed">…</div><div class="l">Compostos</div></div>
    <div class="card"><div class="n" id="n-published">…</div><div class="l">Publicados</div></div>
  </div>

  <div class="add-form">
    <h2>+ Adicionar Produto Manualmente</h2>
    <div class="row full">
      <input id="p-name" placeholder="Nome do produto (ex: Fone Bluetooth TWS i12)" />
    </div>
    <div class="row">
      <input id="p-link" placeholder="Link afiliado Shopee (shope.ee/...)" />
      <input id="p-image" placeholder="URL da imagem do produto (opcional)" />
    </div>
    <div class="row">
      <input id="p-price" placeholder="Preço original (ex: 89.90)" type="number" step="0.01" />
      <input id="p-discount" placeholder="Preço com desconto (ex: 49.90)" type="number" step="0.01" />
    </div>
    <div class="row">
      <input id="p-commission" placeholder="% comissão (ex: 10)" type="number" step="0.1" />
      <input id="p-desc" placeholder="Descrição curta (opcional)" />
    </div>
    <button onclick="addProduct()">Adicionar e Gerar Vídeo</button>
    <div id="add-result"></div>
  </div>

  <div class="btns">
    <button onclick="run('full')">▶ Pipeline Completo</button>
    <button class="secondary" onclick="run('fetch')">1. Buscar Produtos</button>
    <button class="secondary" onclick="run('generate')">2. Gerar Vídeos</button>
    <button class="secondary" onclick="run('compose')">3. Editar Vídeos</button>
    <button class="secondary" onclick="run('publish')">4. Publicar</button>
    <button class="secondary" onclick="run('respond')">5. Responder Comentários</button>
    <button class="secondary" onclick="resetQueue()" style="background:#7f1d1d;color:#fca5a5">↺ Resetar Fila</button>
  </div>

  <table>
    <thead><tr><th>ID</th><th>Produto</th><th>Status</th><th>Comissão</th><th>Post</th></tr></thead>
    <tbody id="rows"><tr><td colspan="5" style="text-align:center;color:#555">Carregando…</td></tr></tbody>
  </table>
  <div id="log"></div>

  <script>
    async function load() {
      const r = await fetch('/api/status');
      const d = await r.json();
      const q = d.queue || {};
      document.getElementById('n-pending').textContent   = q.pending || 0;
      document.getElementById('n-video').textContent     = (q.video_ready || 0) + (q.awaiting_webhook || 0);
      document.getElementById('n-composed').textContent  = q.composed || 0;
      document.getElementById('n-published').textContent = q.published || 0;

      const tbody = document.getElementById('rows');
      if (!d.recent?.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#555">Nenhum produto ainda</td></tr>';
        return;
      }
      tbody.innerHTML = d.recent.map(p => \`
        <tr>
          <td>\${p.id}</td>
          <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${p.name}</td>
          <td><span class="badge \${p.status.replace(/_/g,'-')}">\${p.status}</span></td>
          <td>\${p.commission_pct ? p.commission_pct+'%' : '—'}</td>
          <td>\${p.instagram_post_url ? '<a href="'+p.instagram_post_url+'" target="_blank">Ver post</a>' : '—'}</td>
        </tr>
      \`).join('');
    }

    async function run(step) {
      const log = document.getElementById('log');
      log.style.display = 'block';
      log.textContent += \`\\n[\${new Date().toLocaleTimeString()}] Iniciando: \${step}...\\n\`;
      log.scrollTop = log.scrollHeight;
      try {
        await fetch('/api/run/'+step, { method:'POST' });
        log.textContent += \`Disparado! Aguardando execução...\\n\`;
        setTimeout(load, 3000);
      } catch(e) {
        log.textContent += \`ERRO: \${e.message}\\n\`;
      }
      log.scrollTop = log.scrollHeight;
    }

    async function resetQueue() {
      if (!confirm('Resetar todos os produtos para PENDING? Isso vai regerar todos os vídeos.')) return;
      const log = document.getElementById('log');
      log.style.display = 'block';
      try {
        const r = await fetch('/api/reset', { method:'POST' });
        const d = await r.json();
        log.textContent += \`\\n[\${new Date().toLocaleTimeString()}] Fila resetada: \${d.reset} produtos → pending\\n\`;
        setTimeout(load, 500);
      } catch(e) { log.textContent += \`ERRO reset: \${e.message}\\n\`; }
      log.scrollTop = log.scrollHeight;
    }

    async function addProduct() {
      const name = document.getElementById('p-name').value.trim();
      const link = document.getElementById('p-link').value.trim();
      const res  = document.getElementById('add-result');
      if (!name || !link) { res.className='err'; res.style.display='block'; res.textContent='Nome e link afiliado são obrigatórios'; return; }
      res.style.display='none';
      try {
        const r = await fetch('/api/product/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            affiliate_link:  link,
            image_url:       document.getElementById('p-image').value.trim() || null,
            price_original:  parseFloat(document.getElementById('p-price').value) || 0,
            price_discount:  parseFloat(document.getElementById('p-discount').value) || 0,
            commission_pct:  parseFloat(document.getElementById('p-commission').value) || 0,
            short_desc:      document.getElementById('p-desc').value.trim() || null,
          })
        });
        const d = await r.json();
        if (d.ok) {
          res.className='ok'; res.style.display='block';
          res.textContent='Produto adicionado! ID: '+d.id+' — clique em "2. Gerar Vídeos" para iniciar.';
          ['p-name','p-link','p-image','p-price','p-discount','p-commission','p-desc'].forEach(id=>document.getElementById(id).value='');
          setTimeout(load, 1000);
        } else {
          res.className='err'; res.style.display='block'; res.textContent='Erro: '+(d.error||'desconhecido');
        }
      } catch(e) { res.className='err'; res.style.display='block'; res.textContent='Erro: '+e.message; }
    }

    load();
    setInterval(load, 30000);
  </script>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ─── Request router ───────────────────────────────────────────────────────────

const webhookMiddleware = createWebhookMiddleware();

async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Webhooks
  const handled = await webhookMiddleware(req, res);
  if (handled !== null) return;

  // Dashboard
  if (req.method === 'GET' && (req.url === '/' || req.url === '/dashboard')) {
    return sendDashboard(res);
  }

  // Servir vídeos e áudios compostos (Meta Graph API baixa daqui)
  if (req.method === 'GET' && req.url.startsWith('/videos/')) {
    return serveVideo(req, res);
  }

  // Servir foto do avatar (para lip sync APIs externas)
  // Aceita /avatar/photo.jpg ou /avatar/photo.png
  if (req.method === 'GET' && req.url.startsWith('/avatar/photo')) {
    const jpgPath = path.join(__dirname, 'assets/avatar/photo.jpg');
    const pngPath = path.join(__dirname, 'assets/avatar/photo.png');
    const avatarPath = fs.existsSync(jpgPath) ? jpgPath : pngPath;
    if (!fs.existsSync(avatarPath)) { res.writeHead(404); return res.end('Avatar photo not found'); }
    const isPng = avatarPath.endsWith('.png') || fs.readFileSync(avatarPath).slice(0, 4).toString('hex') === '89504e47';
    res.writeHead(200, { 'Content-Type': isPng ? 'image/png' : 'image/jpeg' });
    return fs.createReadStream(avatarPath).pipe(res);
  }

  // Status JSON
  if (req.method === 'GET' && req.url === '/api/status') {
    try {
      const status = await getStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ...status }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // Adicionar produto manualmente: POST /api/product/add
  if (req.method === 'POST' && req.url === '/api/product/add') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const p = JSON.parse(body);
        if (!p.name || !p.affiliate_link) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'name e affiliate_link obrigatórios' }));
        }
        const shopeeId = `manual_${Date.now()}`;
        const result = await query(
          `INSERT INTO products_queue
            (shopee_id, name, affiliate_link, image_url, price_original, price_discount, commission_pct, short_desc, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
           ON CONFLICT (shopee_id) DO NOTHING
           RETURNING id`,
          [shopeeId, p.name, p.affiliate_link, p.image_url || null,
           p.price_original || 0, p.price_discount || 0,
           p.commission_pct || 0, p.short_desc || null]
        );
        const id = result.rows[0]?.id;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // Reset da fila: POST /api/reset  (volta produtos para 'pending' para regerar)
  if (req.method === 'POST' && req.url === '/api/reset') {
    try {
      const r = await query(
        `UPDATE products_queue
            SET status='pending', video_raw_url=NULL, video_public_url=NULL,
                instagram_media_id=NULL, video_local_path=NULL, updated_at=NOW()
          RETURNING id`
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, reset: r.rowCount }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // Trigger manual: POST /api/run/:step
  const match = req.url.match(/^\/api\/run\/([\w]+)$/);
  if (req.method === 'POST' && match) {
    const step = match[1];
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, step }));
    setImmediate(async () => {
      try { await runPipeline(step); }
      catch (err) { log.error(`Trigger '${step}' falhou`, { error: err.message }); }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

// ─── Cron interno ─────────────────────────────────────────────────────────────

function scheduleCron() {
  const seen = new Set();

  setInterval(async () => {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    const key = (label) => `${label}-${now.toDateString()}-${h}`;

    // 07h00 e 19h00 → fetch + generate
    if ([7, 19].includes(h) && m === 0 && !seen.has(key('fetch'))) {
      seen.add(key('fetch'));
      log.info(`[CRON ${h}h] fetch → generate`);
      runPipeline('fetch').then(() => runPipeline('generate')).catch(e => log.error('[CRON]', { error: e.message }));
    }

    // 08h00 e 20h00 → compose + publish + stories
    if ([8, 20].includes(h) && m === 0 && !seen.has(key('publish'))) {
      seen.add(key('publish'));
      log.info(`[CRON ${h}h] compose → publish → stories`);
      runPipeline('compose')
        .then(() => runPipeline('publish'))
        .then(() => runPipeline('stories'))
        .catch(e => log.error('[CRON]', { error: e.message }));
    }

    // A cada 30 min → respond
    if (m % 30 === 0 && !seen.has(`respond-${h}-${m}`)) {
      seen.add(`respond-${h}-${m}`);
      runPipeline('respond').catch(e => log.error('[CRON respond]', { error: e.message }));
    }
  }, 60 * 1000);

  log.info('Cron scheduler ativo (fetch 7h/19h, publish 8h/20h, respond cada 30 min)');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function main() {
  log.info('Iniciando orquestrador...');
  if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

  await migrate();

  const server = http.createServer((req, res) => {
    req.setTimeout(300000);
    handleRequest(req, res).catch(err => {
      log.error('Handler error', { error: err.message });
      try { res.writeHead(500); res.end('Error'); } catch {}
    });
  });

  server.listen(PORT, () => {
    log.info(`Orquestrador na porta ${PORT}`);
    log.info(`Dashboard: http://localhost:${PORT}/`);
    log.info(`Vídeos:    http://localhost:${PORT}/videos/<arquivo.mp4>`);
    log.info(`Status:    http://localhost:${PORT}/api/status`);
    log.info(`Trigger:   POST http://localhost:${PORT}/api/run/{fetch|generate|compose|publish|respond|full}`);
  });

  scheduleCron();

  process.on('SIGTERM', async () => {
    log.info('SIGTERM — encerrando...');
    server.close();
    await close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Falha fatal:', err.message);
  process.exit(1);
});
