# 🤖 Claude Chat Server

> Servidor Node.js para chat com Claude AI + Bot Telegram

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)
![Claude](https://img.shields.io/badge/Claude-AI-6B4FBB?logo=anthropic&logoColor=white)
![Telegram](https://img.shields.io/badge/Telegram-Bot-26A5E4?logo=telegram&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green)

## 📋 Sobre

Servidor HTTP leve em Node.js puro (sem frameworks) que integra a **Claude AI** via CLI, com interface web de chat e bot Telegram. Permite conversar com Claude através de um navegador web ou via Telegram.

### ✨ Features

- 💬 **Chat Web** — Interface de chat no browser com UI moderna
- 🤖 **Bot Telegram** — Converse com Claude pelo Telegram
- 🔄 **Sessões** — Mantém contexto entre mensagens
- ⚡ **Zero dependências externas** — Server HTTP nativo do Node.js
- 🕐 **Timeout de 5 min** — Para respostas longas do Claude

## 🏗️ Arquitetura

```
claude-chat-server/
├── server.js           # Servidor HTTP + API de chat
├── index.html          # Interface web do chat
├── telegram-bot.js     # Bot Telegram integrado
└── package.json        # Configuração do projeto
```

## 🚀 Como Executar

```bash
# 1. Clone o repositório
git clone https://github.com/matheusbritosc-dev/claude-chat-server.git
cd claude-chat-server

# 2. Instale as dependências
npm install

# 3. Execute o servidor
node server.js

# Acesse: http://localhost:3456
```

### Bot Telegram
```bash
# Configure o token do bot no arquivo
node telegram-bot.js
```

## 🛠️ Tech Stack

- **Runtime:** Node.js 18+
- **HTTP:** Módulo nativo `http` (zero frameworks)
- **IA:** Claude CLI (Anthropic)
- **Bot:** API Telegram

## 📄 Licença

MIT License — Desenvolvido por **Matheus Brito**
