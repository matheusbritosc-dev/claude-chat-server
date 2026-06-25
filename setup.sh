#!/usr/bin/env bash
# setup.sh — Setup inicial no VPS Hostinger
# Uso: bash setup.sh

set -e
echo "=== Instagram × Shopee Affiliate Automation — Setup ==="

# ── Dependências do sistema ────────────────────────────────────────────────────
echo "[1/6] Verificando dependências do sistema..."
command -v ffmpeg   >/dev/null 2>&1 || { echo "ERRO: ffmpeg não encontrado. Execute: sudo apt install ffmpeg"; exit 1; }
command -v node     >/dev/null 2>&1 || { echo "ERRO: node não encontrado."; exit 1; }
command -v psql     >/dev/null 2>&1 || { echo "AVISO: psql não encontrado. Instale PostgreSQL."; }
command -v pm2      >/dev/null 2>&1 || { echo "Instalando PM2..."; npm install -g pm2; }

echo "  ffmpeg: $(ffmpeg -version 2>&1 | head -1)"
echo "  node:   $(node --version)"
echo "  pm2:    $(pm2 --version)"

# ── Dependências Node ──────────────────────────────────────────────────────────
echo "[2/6] Instalando dependências Node..."
npm install

# ── Diretórios ─────────────────────────────────────────────────────────────────
echo "[3/6] Criando diretórios..."
mkdir -p tmp/videos logs assets/music

# ── Configuração ───────────────────────────────────────────────────────────────
echo "[4/6] Configuração..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  ⚠️  Arquivo .env criado a partir de .env.example"
  echo "  ⚠️  EDITE .env com suas credenciais antes de continuar!"
else
  echo "  .env já existe."
fi

# ── PostgreSQL ─────────────────────────────────────────────────────────────────
echo "[5/6] Banco de dados..."
DB_NAME="${DB_NAME:-shopee_automation}"
DB_USER="${DB_USER:-shopee_bot}"

if command -v psql >/dev/null 2>&1; then
  sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 || \
    sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME};"
  sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 || \
    sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH ENCRYPTED PASSWORD 'change_me_in_env';"
  sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"
  echo "  Banco '${DB_NAME}' e usuário '${DB_USER}' configurados."
fi

# ── PM2 ────────────────────────────────────────────────────────────────────────
echo "[6/6] Configurando PM2..."
pm2 startup || true
echo "  Execute 'pm2 start ecosystem.config.js --env production' para iniciar."

echo ""
echo "=== Setup concluído! ==="
echo ""
echo "Próximos passos:"
echo "  1. Edite .env com todas as credenciais"
echo "  2. pm2 start ecosystem.config.js --env production"
echo "  3. pm2 save"
echo "  4. Verifique: curl http://localhost:3457/api/status"
echo ""
echo "Trigger manual do pipeline completo:"
echo "  curl -X POST http://localhost:3457/api/run/full"
echo ""
echo "=== Setup de Clone de Voz (GPT-SoVITS) ==="
echo ""
echo "  # Instala e inicia GPT-SoVITS (requer conda):"
echo "  git clone https://github.com/RVC-Boss/GPT-SoVITS"
echo "  cd GPT-SoVITS"
echo "  conda create -n GPTSoVits python=3.10 -y && conda activate GPTSoVits"
echo "  bash install.sh --device CPU    # ou CU126 para GPU NVIDIA"
echo "  python api_v2.py -a 0.0.0.0 -p 9880 &"
echo ""
echo "  # Adicione sua voz de referência (5-30 segundos, WAV ou MP3):"
echo "  cp sua_voz.wav assets/voice/reference.wav"
echo ""
echo "  # Adicione sua foto para o avatar:"
echo "  cp sua_foto.jpg assets/avatar/photo.jpg"
echo ""
echo "  # Teste a voz clonada:"
echo "  node -e \"require('dotenv').config(); const {generateNarration}=require('./src/editor/voice-clone'); generateNarration('Olá! Esse produto está incrível, vem conferir na bio!', '/tmp/test.wav').then(r=>console.log(r))\""
