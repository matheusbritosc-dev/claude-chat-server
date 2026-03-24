const TelegramBot = require('node-telegram-bot-api');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ═══════════════════════════════════════════════════════════
//  🤖 CLAUDE TELEGRAM BOT
//  Conecta a Claude AI ao Telegram via Claude Code CLI
// ═══════════════════════════════════════════════════════════

// ⚠️ COLOQUE SEU TOKEN DO BOTFATHER AQUI:
const TOKEN = process.env.TELEGRAM_TOKEN || 'SEU_TOKEN_AQUI';

if (TOKEN === 'SEU_TOKEN_AQUI') {
    console.error('\n❌ Token não configurado!');
    console.error('   1. Abra o Telegram e busque @BotFather');
    console.error('   2. Envie /newbot e siga as instruções');
    console.error('   3. Copie o token gerado');
    console.error('   4. Cole no arquivo telegram-bot.js na linha do TOKEN');
    console.error('   Ou rode: set TELEGRAM_TOKEN=seu_token_aqui && node telegram-bot.js\n');
    process.exit(1);
}

const claudePath = path.join(process.env.USERPROFILE || process.env.HOME, '.local', 'bin', 'claude.exe');

// Armazena sessões por chat ID para manter contexto
const sessions = new Map();

// Configurações
const MAX_MESSAGE_LENGTH = 4096; // Limite do Telegram
const TIMEOUT_MS = 120000; // 2 minutos

// Inicializa o bot
const bot = new TelegramBot(TOKEN, { polling: true });

console.log('\n🤖 Claude Telegram Bot iniciado!');
console.log(`   Claude: ${claudePath}`);
console.log('   Aguardando mensagens...\n');

// Comando /start
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const name = msg.from.first_name || 'Usuário';

    bot.sendMessage(chatId,
        `✨ *Olá, ${name}!*\n\n` +
        `Sou um bot conectado à *Claude AI* (Anthropic).\n\n` +
        `📝 *Como usar:*\n` +
        `• Envie qualquer mensagem e eu responderei\n` +
        `• Use /novo para iniciar uma nova conversa\n` +
        `• Use /ajuda para ver todos os comandos\n\n` +
        `💬 Me envie sua primeira pergunta!`,
        { parse_mode: 'Markdown' }
    );
});

// Comando /novo - Nova conversa
bot.onText(/\/novo/, (msg) => {
    const chatId = msg.chat.id;
    sessions.delete(chatId);
    bot.sendMessage(chatId, '🔄 Nova conversa iniciada! O contexto anterior foi limpo.');
});

// Comando /ajuda
bot.onText(/\/ajuda|\/help/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId,
        `🤖 *Comandos disponíveis:*\n\n` +
        `/start — Mensagem de boas-vindas\n` +
        `/novo — Iniciar nova conversa (limpa contexto)\n` +
        `/ajuda — Ver esta lista de comandos\n` +
        `/status — Ver status do bot\n\n` +
        `💡 *Dicas:*\n` +
        `• A Claude mantém contexto da conversa\n` +
        `• Use /novo se quiser trocar de assunto\n` +
        `• Pode enviar textos longos sem problema\n` +
        `• A resposta pode demorar alguns segundos`,
        { parse_mode: 'Markdown' }
    );
});

// Comando /status
bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    const session = sessions.get(chatId);
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);

    bot.sendMessage(chatId,
        `📊 *Status do Bot:*\n\n` +
        `🟢 Bot: Online\n` +
        `⏰ Uptime: ${hours}h ${mins}m\n` +
        `💬 Sessão ativa: ${session ? 'Sim' : 'Não'}\n` +
        `🆔 Seu Chat ID: \`${chatId}\``,
        { parse_mode: 'Markdown' }
    );
});

// Handler principal de mensagens
bot.on('message', (msg) => {
    // Ignora comandos
    if (msg.text && msg.text.startsWith('/')) return;
    // Ignora mensagens sem texto
    if (!msg.text) return;

    handleMessage(msg);
});

async function handleMessage(msg) {
    const chatId = msg.chat.id;
    const userText = msg.text;
    const userName = msg.from.first_name || 'Usuário';

    console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${userName} (${chatId}): ${userText.substring(0, 80)}`);

    // Mostra "digitando..."
    bot.sendChatAction(chatId, 'typing');

    // Manter "digitando" enquanto processa
    const typingInterval = setInterval(() => {
        bot.sendChatAction(chatId, 'typing').catch(() => { });
    }, 4000);

    try {
        const response = await askClaude(userText, chatId);

        clearInterval(typingInterval);

        if (response) {
            // Divide mensagens longas
            const chunks = splitMessage(response);
            for (const chunk of chunks) {
                await bot.sendMessage(chatId, chunk, {
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true
                }).catch(async () => {
                    // Se falhar com Markdown, tenta sem formatação
                    await bot.sendMessage(chatId, chunk);
                });
            }
            console.log(`[${new Date().toLocaleTimeString('pt-BR')}] → Resposta enviada (${response.length} chars)`);
        } else {
            await bot.sendMessage(chatId, '⚠️ Desculpe, não consegui gerar uma resposta. Tente novamente.');
        }
    } catch (error) {
        clearInterval(typingInterval);
        console.error(`[Error] ${error.message}`);
        await bot.sendMessage(chatId, `⚠️ Erro ao processar: ${error.message.substring(0, 200)}`);
    }
}

function askClaude(message, chatId) {
    return new Promise((resolve, reject) => {
        const args = ['-p', message, '--output-format', 'json'];

        // Se tem sessão anterior, continua a conversa
        const sessionId = sessions.get(chatId);
        if (sessionId) {
            args.push('--resume', sessionId);
        }

        const child = spawn(claudePath, args, {
            cwd: __dirname,
            env: { ...process.env },
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += data.toString('utf-8');
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString('utf-8');
        });

        // Timeout
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error('Timeout: Claude demorou mais de 2 minutos para responder.'));
        }, TIMEOUT_MS);

        child.on('error', (err) => {
            clearTimeout(timer);
            reject(new Error('Erro ao iniciar Claude: ' + err.message));
        });

        child.on('close', (code) => {
            clearTimeout(timer);

            if (!stdout.trim()) {
                reject(new Error('Claude não retornou resposta. ' + (stderr.substring(0, 100) || `Exit: ${code}`)));
                return;
            }

            try {
                const result = JSON.parse(stdout.trim());
                const responseText = result.result || '';
                const newSessionId = result.session_id || null;

                // Salva sessão
                if (newSessionId) {
                    sessions.set(chatId, newSessionId);
                }

                const cost = result.total_cost_usd || 0;
                console.log(`   [Claude] ${responseText.substring(0, 60)}... ($${cost.toFixed(4)})`);

                resolve(responseText);
            } catch (e) {
                // Se não é JSON válido, retorna como texto
                resolve(stdout.trim());
            }
        });
    });
}

function splitMessage(text) {
    if (text.length <= MAX_MESSAGE_LENGTH) return [text];

    const chunks = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= MAX_MESSAGE_LENGTH) {
            chunks.push(remaining);
            break;
        }

        // Tenta dividir em uma nova linha
        let splitIndex = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
        if (splitIndex === -1 || splitIndex < MAX_MESSAGE_LENGTH / 2) {
            // Tenta dividir em um espaço
            splitIndex = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
        }
        if (splitIndex === -1) {
            splitIndex = MAX_MESSAGE_LENGTH;
        }

        chunks.push(remaining.substring(0, splitIndex));
        remaining = remaining.substring(splitIndex).trimStart();
    }

    return chunks;
}

// Tratamento de erros globais
bot.on('polling_error', (error) => {
    console.error(`[Polling Error] ${error.message}`);
});

process.on('SIGINT', () => {
    console.log('\n\n👋 Bot encerrado!');
    bot.stopPolling();
    process.exit(0);
});

console.log('✅ Bot pronto! Envie uma mensagem para seu bot no Telegram.');
