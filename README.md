# 🧠 arOS — versão privada

> **Sistema Operacional de Agentes Resolutivos** — reconstrução self-hosted e privada do conceito do [arOS](https://aros.com.br). Dashboard de agentes de IA de marketing (Zero Prompt / Marketing Raiz) rodando localmente e movido a Claude.

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)
![Claude](https://img.shields.io/badge/Claude-AI-6B4FBB?logo=anthropic&logoColor=white)
![Zero_Deps](https://img.shields.io/badge/Dependências-zero-c084fc)
![License](https://img.shields.io/badge/License-MIT-green)

## 📋 Sobre

Versão privada de um sistema no estilo arOS: em vez de escrever prompts, você
escolhe um **Agente Resolutivo**, preenche um briefing curto e recebe o
entregável de marketing pronto para publicar (copy, carrossel, funil, anúncios,
roteiros, ofertas, e-mails, ideias). Tudo servido por um HTTP server em Node
puro (zero frameworks) que roda os agentes via **Claude CLI**.

### ✨ Features

- 🔐 **Acesso privado** — login por senha com sessão em cookie
- 🤖 **8 Agentes Resolutivos** — copy, carrossel, funil, ads, YouTube, oferta, e-mail, ideias
- ⚡ **Zero Prompt** — cada agente monta o prompt completo por baixo; você só dá o briefing
- 🗂️ **Projetos** — organize entregáveis por projeto (no navegador)
- 📚 **Biblioteca** — salve, revise e copie os entregáveis gerados
- 🎭 **Modo demonstração** — funciona mesmo sem o Claude CLI instalado
- 📦 **Zero dependências** para o servidor web (só o módulo `http` nativo)

## 🏗️ Arquitetura

```
claude-chat-server/
├── server.js        # HTTP server: auth, rotas /api, execução dos agentes
├── agents.js        # Definições dos Agentes Resolutivos (Zero Prompt)
├── dashboard.html   # Dashboard privado (sidebar, galeria, executor, biblioteca)
├── login.html       # Tela de login
└── package.json
```

## 🚀 Como executar

```bash
# 1. Defina uma senha de acesso (recomendado)
export AROS_PASSWORD="sua-senha-forte"

# 2. (Opcional) aponte o Claude CLI, se não estiver no PATH
export CLAUDE_PATH="/caminho/para/claude"

# 3. Suba o servidor
node server.js

# Acesse: http://localhost:3456   (senha padrão: aros)
```

### Variáveis de ambiente

| Variável        | Padrão | Descrição                                        |
| --------------- | ------ | ------------------------------------------------ |
| `PORT`          | `3456` | Porta do servidor                                |
| `AROS_PASSWORD` | `aros` | Senha de acesso ao dashboard                     |
| `CLAUDE_PATH`   | auto   | Caminho do binário do Claude CLI                 |
| `AROS_MOCK`     | —      | `1` força o modo demonstração (sem chamar a IA)  |

Se o Claude CLI não for encontrado, o sistema entra em **modo demonstração**
automaticamente e devolve um entregável de exemplo — o dashboard continua
navegável.

## 🤖 Agentes disponíveis

| Agente | O que entrega |
| --- | --- |
| ✍️ Copy que Vende | VSL, carta de vendas, página, headline |
| 🎠 Carrossel Viral | Roteiro slide a slide para Instagram |
| 🧲 Funil de Alta Conversão | Funil completo: LP, VSL, e-mails, upsell |
| 📣 Anúncios que Escalam | Criativos em vários ângulos |
| 🎬 Roteiro YouTube | Roteiro com hook e retenção |
| 💎 Oferta Irresistível | Oferta com stack de valor e garantia |
| 📧 Sequência de E-mail | Sequências de nutrição e lançamento |
| 💡 Ideias Virais | Banco de ideias de conteúdo que vende |

## 🛠️ Tech Stack

- **Runtime:** Node.js 18+
- **HTTP:** módulo nativo `http` (zero frameworks)
- **IA:** Claude CLI (Anthropic), via `--output-format json`
- **Front-end:** HTML/CSS/JS puro, sem build

## 📄 Licença

MIT License — reconstrução privada para fins próprios de **Matheus Brito**.
Não afiliada ao arOS oficial; feita como sistema self-hosted independente.
