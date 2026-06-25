#!/usr/bin/env bash
# setup-voice.sh — Extrai voz de referência para clone + descobre ID do Instagram
# Uso: bash setup-voice.sh
set -e

echo "=== Setup de Voz e Instagram ==="
echo ""

# ── 1. Extrai áudio do vídeo de referência ─────────────────────────────────────
if [ -f "assets/voice/reference_source.mp4" ]; then
  echo "[1/3] Extraindo áudio de referência para clone de voz..."
  mkdir -p assets/voice
  ffmpeg -y -i assets/voice/reference_source.mp4 \
    -vn -ar 44100 -ac 1 -c:a pcm_s16le \
    assets/voice/reference.wav
  echo "  ✓ Arquivo gerado: assets/voice/reference.wav"
  DUR=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 assets/voice/reference.wav 2>/dev/null | cut -d. -f1)
  echo "  Duração: ${DUR}s (ideal: 5-30s)"
else
  echo "[1/3] ⚠️  Coloque o vídeo de referência em: assets/voice/reference_source.mp4"
  echo "      Depois rode: ffmpeg -i assets/voice/reference_source.mp4 -vn -ar 44100 -ac 1 -c:a pcm_s16le assets/voice/reference.wav"
fi
echo ""

# ── 2. Converte avatar PNG→JPEG se necessário ──────────────────────────────────
if [ -f "assets/avatar/photo.jpg" ]; then
  MAGIC=$(xxd -l4 assets/avatar/photo.jpg | head -1)
  if echo "$MAGIC" | grep -q "8950 4e47"; then
    echo "[2/3] Convertendo avatar PNG → JPEG..."
    ffmpeg -y -i assets/avatar/photo.jpg -q:v 2 /tmp/avatar_converted.jpg
    mv /tmp/avatar_converted.jpg assets/avatar/photo.jpg
    echo "  ✓ Avatar convertido para JPEG"
  else
    echo "[2/3] ✓ Avatar já é JPEG"
  fi
else
  echo "[2/3] ⚠️  Coloque sua foto em: assets/avatar/photo.jpg"
fi
echo ""

# ── 3. Descobre ID da conta Instagram Business ─────────────────────────────────
if [ -f ".env" ]; then
  TOKEN=$(grep "^META_ACCESS_TOKEN=" .env | cut -d= -f2-)
  if [ -n "$TOKEN" ] && [ "$TOKEN" != "seu_long_lived_page_access_token" ]; then
    echo "[3/3] Descobrindo ID da conta Instagram Business..."
    echo ""
    PAGES=$(curl -s "https://graph.facebook.com/v21.0/me/accounts?fields=instagram_business_account,name&access_token=${TOKEN}")
    echo "Páginas conectadas:"
    echo "$PAGES" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    pages = d.get('data', [])
    if not pages:
        print('  Nenhuma página encontrada. Verifique se o token tem permissão pages_show_list.')
    for p in pages:
        name = p.get('name', 'Sem nome')
        ig = p.get('instagram_business_account', {})
        ig_id = ig.get('id', 'NÃO VINCULADO')
        print(f'  Página: {name}')
        print(f'  Instagram Business Account ID: {ig_id}')
        print()
    if pages:
        ig_ids = [p.get('instagram_business_account', {}).get('id') for p in pages if p.get('instagram_business_account')]
        if ig_ids:
            print('--- COPIE ESTE VALOR PARA .env ---')
            print(f'META_INSTAGRAM_ACCOUNT_ID={ig_ids[0]}')
except Exception as e:
    print(f'Erro ao processar resposta: {e}')
    print('Resposta bruta:', sys.stdin.read() if not sys.stdin.closed else '')
" 2>/dev/null || echo "$PAGES"
  else
    echo "[3/3] META_ACCESS_TOKEN não configurado no .env"
  fi
else
  echo "[3/3] Arquivo .env não encontrado. Rode: cp .env.example .env"
fi

echo ""
echo "=== Próximos passos ==="
echo "  1. Copie META_INSTAGRAM_ACCOUNT_ID para o .env"
echo "  2. Configure PUBLIC_BASE_URL no .env com seu domínio HTTPS"
echo "  3. pm2 start ecosystem.config.js --env production"
echo "  4. curl http://localhost:3457/api/status"
