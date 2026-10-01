#!/data/data/com.termux/files/usr/bin/bash
# Instala el bot de trading en Android con Termux (https://f-droid.org/packages/com.termux/).
# Uso, dentro de Termux:
#   curl -fsSL https://raw.githubusercontent.com/miguelgutierrezortega5-ops/edgar-mcp-server/ccr-6370af02-zxtdm6/trading-bot/scripts/android/instalar.sh | bash
set -e
REPO="https://github.com/miguelgutierrezortega5-ops/edgar-mcp-server.git"
RAMA="${RAMA:-ccr-6370af02-zxtdm6}"

echo "== Actualizando Termux e instalando Node.js y Git =="
apt-get update -y
apt-get -y -o Dpkg::Options::=--force-confnew upgrade
apt-get -y install nodejs-lts git procps

echo "== Descargando el bot =="
cd "$HOME"
if [ -d edgar-mcp-server/.git ]; then
  git -C edgar-mcp-server fetch origin "$RAMA"
  git -C edgar-mcp-server checkout "$RAMA"
  git -C edgar-mcp-server pull --ff-only origin "$RAMA"
else
  git clone --branch "$RAMA" "$REPO"
fi

echo "== Instalando dependencias y compilando (unos minutos) =="
cd "$HOME/edgar-mcp-server/trading-bot"
npm install --no-fund --no-audit
[ -f .env ] || cp .env.example .env

echo "== Comprobando conexiones desde tu teléfono =="
node dist/index.js diagnostico || true

echo
echo "Listo. Para arrancar el reto de 50 USD:  bash ~/edgar-mcp-server/trading-bot/scripts/android/iniciar.sh"
