/**
 * arOS — versão privada (Sistema Operacional de Agentes Resolutivos)
 *
 * Servidor HTTP leve (Node puro) que serve o dashboard privado e roda os
 * Agentes Resolutivos via Claude CLI. Reconstrução self-hosted do conceito
 * arOS: login, dashboard, galeria de agentes e execução Zero Prompt.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const { listAgents, getAgent } = require('./agents');

const PORT = process.env.PORT || 3456;
const PASSWORD = process.env.AROS_PASSWORD || 'aros';
const sessions = new Set(); // tokens de sessão válidos (em memória)

// ---------------------------------------------------------------------------
// Detecção do Claude CLI (multiplataforma) + modo mock quando indisponível
// ---------------------------------------------------------------------------
function resolveClaudePath() {
  if (process.env.CLAUDE_PATH && fs.existsSync(process.env.CLAUDE_PATH)) {
    return process.env.CLAUDE_PATH;
  }
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.local', 'bin', 'claude.exe'),
    '/usr/local/bin/claude',
    '/usr/bin/claude'
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const found = execSync(`${which} claude`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split(/\r?\n/)[0]
      .trim();
    if (found && fs.existsSync(found)) return found;
  } catch (_) {
    /* not found */
  }
  return null;
}

const claudePath = resolveClaudePath();
const USE_MOCK = !claudePath || process.env.AROS_MOCK === '1';

// ---------------------------------------------------------------------------
// Helpers HTTP
// ---------------------------------------------------------------------------
function sendJson(res, data, statusCode = 200, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  });
  res.end(JSON.stringify(data));
}

function serveFile(res, file, type) {
  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
    res.end(data);
  });
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(
    raw.split(';').map((c) => {
      const [k, ...v] = c.trim().split('=');
      return [k, decodeURIComponent(v.join('='))];
    }).filter(([k]) => k)
  );
}

function isAuthed(req) {
  const token = parseCookies(req).aros_session;
  return token && sessions.has(token);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Execução dos agentes
// ---------------------------------------------------------------------------
function runClaude(prompt, conversationId) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'json'];
    if (conversationId) args.push('--resume', conversationId);

    const child = spawn(claudePath, args, {
      cwd: __dirname,
      env: { ...process.env },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString('utf-8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf-8')));
    child.on('error', (err) =>
      resolve({ success: false, error: 'Erro ao iniciar Claude: ' + err.message })
    );
    child.on('close', () => {
      if (!stdout.trim()) {
        return resolve({
          success: false,
          error: 'Claude não retornou resposta. ' + stderr.substring(0, 200)
        });
      }
      try {
        const r = JSON.parse(stdout.trim());
        resolve({
          success: true,
          response: r.result || '',
          sessionId: r.session_id || null,
          cost: r.total_cost_usd || 0
        });
      } catch {
        resolve({ success: true, response: stdout.trim(), sessionId: null, cost: 0 });
      }
    });
  });
}

// Gera um entregável de demonstração quando o Claude CLI não está disponível,
// para que o dashboard seja funcional/apresentável mesmo offline.
function runMock(agent, inputs) {
  const list = Object.entries(inputs)
    .filter(([, v]) => v)
    .map(([k, v]) => `- **${k}:** ${v}`)
    .join('\n');
  const response = `## ${agent.icon} ${agent.name} — entregável (modo demonstração)

> Gerado sem o Claude CLI conectado. Configure \`CLAUDE_PATH\` ou instale o Claude Code para saída real.

**Briefing recebido**
${list || '- (sem campos)'}

### Prévia do que o agente entregaria
1. **Gancho / Headline** alinhado ao público informado.
2. **Desenvolvimento** no formato do agente "${agent.name}", com gatilhos de Marketing Raiz.
3. **CTA** clara e pronta para publicar.

_Este é um placeholder determinístico. Com o Claude conectado, o agente devolve o conteúdo completo._`;
  return { success: true, response, sessionId: null, cost: 0, mock: true };
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  req.setTimeout(300000);
  res.setTimeout(300000);
  const url = req.url.split('?')[0];

  // --- Auth: login ---
  if (req.method === 'POST' && url === '/api/login') {
    const { password } = await readBody(req);
    if (password === PASSWORD) {
      const token = crypto.randomBytes(24).toString('hex');
      sessions.add(token);
      return sendJson(res, { success: true }, 200, {
        'Set-Cookie': `aros_session=${token}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`
      });
    }
    return sendJson(res, { success: false, error: 'Senha incorreta' }, 401);
  }

  if (req.method === 'POST' && url === '/api/logout') {
    const token = parseCookies(req).aros_session;
    sessions.delete(token);
    return sendJson(res, { success: true }, 200, {
      'Set-Cookie': 'aros_session=; HttpOnly; Path=/; Max-Age=0'
    });
  }

  // --- Páginas ---
  if (req.method === 'GET' && (url === '/' || url === '/dashboard')) {
    if (!isAuthed(req)) return serveFile(res, 'login.html', 'text/html');
    return serveFile(res, 'dashboard.html', 'text/html');
  }
  if (req.method === 'GET' && url === '/login') {
    return serveFile(res, 'login.html', 'text/html');
  }

  // --- API protegida ---
  if (url.startsWith('/api/')) {
    if (!isAuthed(req)) return sendJson(res, { success: false, error: 'Não autorizado' }, 401);

    if (req.method === 'GET' && url === '/api/agents') {
      return sendJson(res, { success: true, agents: listAgents(), mode: USE_MOCK ? 'demo' : 'live' });
    }

    if (req.method === 'POST' && url === '/api/run') {
      const { agentId, inputs = {}, sessionId } = await readBody(req);
      const agent = getAgent(agentId);
      if (!agent) return sendJson(res, { success: false, error: 'Agente não encontrado' }, 404);

      const missing = (agent.fields || []).filter((f) => f.required && !inputs[f.name]);
      if (missing.length) {
        return sendJson(res, {
          success: false,
          error: 'Campos obrigatórios: ' + missing.map((f) => f.label).join(', ')
        }, 400);
      }

      console.log(`[Run] agent=${agentId} mock=${USE_MOCK}`);
      const result = USE_MOCK
        ? runMock(agent, inputs)
        : await runClaude(agent.buildPrompt(inputs), sessionId);
      return sendJson(res, result);
    }

    return sendJson(res, { success: false, error: 'Rota não encontrada' }, 404);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.timeout = 300000;
server.keepAliveTimeout = 300000;
server.headersTimeout = 310000;

server.listen(PORT, () => {
  console.log(`\n🧠 arOS (privado) rodando em http://localhost:${PORT}`);
  console.log(`   Modo: ${USE_MOCK ? 'DEMONSTRAÇÃO (Claude CLI não encontrado)' : 'LIVE — ' + claudePath}`);
  console.log(`   Senha de acesso: ${PASSWORD === 'aros' ? 'aros (padrão — troque via AROS_PASSWORD)' : '••• (via AROS_PASSWORD)'}`);
  console.log(`   Ctrl+C para parar\n`);
});
