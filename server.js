const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3456;
const claudePath = path.join(process.env.USERPROFILE || process.env.HOME, '.local', 'bin', 'claude.exe');

function serveFrontend(res) {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Error loading page');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
    });
}

function handleChat(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        try {
            const { message, conversationId } = JSON.parse(body);
            console.log(`[Chat] Message: "${message.substring(0, 100)}"`);

            // Build args array — message is a single argument to -p
            const args = ['-p', message, '--output-format', 'json'];
            if (conversationId) {
                args.push('--resume', conversationId);
            }

            console.log(`[Chat] Spawning claude with ${args.length} args`);

            // Use spawn with shell:false — this correctly passes message as single arg
            const child = spawn(claudePath, args, {
                cwd: __dirname,
                env: { ...process.env },
                shell: false,
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';
            let responded = false;

            child.stdout.on('data', (data) => {
                stdout += data.toString('utf-8');
            });

            child.stderr.on('data', (data) => {
                stderr += data.toString('utf-8');
            });

            child.on('error', (err) => {
                console.error(`[Chat] Spawn error: ${err.message}`);
                if (!responded) {
                    responded = true;
                    sendJson(res, { success: false, error: 'Erro ao iniciar Claude: ' + err.message });
                }
            });

            child.on('close', (code) => {
                console.log(`[Chat] Claude exited code=${code}, stdout=${stdout.length} bytes, stderr=${stderr.length} bytes`);
                if (stderr) console.log(`[Chat] stderr: ${stderr.substring(0, 300)}`);

                if (responded) return;
                responded = true;

                if (!stdout.trim()) {
                    console.error(`[Chat] No stdout. stderr: ${stderr.substring(0, 500)}`);
                    sendJson(res, {
                        success: false,
                        error: 'Claude nao retornou resposta. ' + (stderr.substring(0, 200) || `Exit code: ${code}`)
                    });
                    return;
                }

                try {
                    const result = JSON.parse(stdout.trim());
                    const responseText = result.result || '';
                    const sessionId = result.session_id || null;
                    const cost = result.total_cost_usd || 0;
                    console.log(`[Chat] OK: "${responseText.substring(0, 80)}..." cost=$${cost.toFixed(4)}`);
                    sendJson(res, { success: true, response: responseText, sessionId, cost });
                } catch (e) {
                    console.error(`[Chat] JSON parse error: ${e.message}`);
                    console.log(`[Chat] Raw stdout (first 500): ${stdout.substring(0, 500)}`);
                    // Try to return raw text as response
                    sendJson(res, { success: true, response: stdout.trim(), sessionId: null, cost: 0 });
                }
            });

            // Do NOT kill child on client disconnect — let it finish
            // The response just won't be sent, but we don't waste the API call

        } catch (e) {
            sendJson(res, { success: false, error: 'Requisicao invalida: ' + e.message }, 400);
        }
    });
}

function sendJson(res, data, statusCode = 200) {
    try {
        if (!res.headersSent) {
            res.writeHead(statusCode, {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*'
            });
        }
        res.end(JSON.stringify(data));
    } catch (e) {
        console.error(`[SendJson] Error: ${e.message}`);
    }
}

const server = http.createServer((req, res) => {
    req.setTimeout(300000); // 5 min
    res.setTimeout(300000);

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        serveFrontend(res);
    } else if (req.method === 'POST' && req.url === '/api/chat') {
        handleChat(req, res);
    } else if (req.method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

server.timeout = 300000;
server.keepAliveTimeout = 300000;
server.headersTimeout = 310000;

server.listen(PORT, () => {
    console.log(`\n🤖 Claude Chat Server v3 running at http://localhost:${PORT}`);
    console.log(`   Claude: ${claudePath}`);
    console.log(`   Timeout: 5 min per request`);
    console.log(`   Press Ctrl+C to stop\n`);
});
