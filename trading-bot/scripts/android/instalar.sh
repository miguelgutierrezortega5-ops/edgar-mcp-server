#!/data/data/com.termux/files/usr/bin/bash
# Instala el bot de trading en Android con Termux (https://f-droid.org/packages/com.termux/).
# Uso, dentro de Termux:
#   curl -fsSL https://raw.githubusercontent.com/miguelgutierrezortega5-ops/edgar-mcp-server/ccr-6370af02-zxtdm6/trading-bot/scripts/android/instalar.sh | bash
# Todo va dentro de main para que bash lea el script entero antes de ejecutarlo: con "curl | bash"
# la entrada es el propio script y un programa que leyera de ella se comería el resto.
set -e
REPO="https://github.com/miguelgutierrezortega5-ops/edgar-mcp-server.git"
RAMA="${RAMA:-ccr-6370af02-zxtdm6}"

main() {
  echo "== Actualizando Termux e instalando Node.js y Git =="
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y </dev/null
  apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confnew upgrade </dev/null
  apt-get -y install nodejs-lts git procps </dev/null

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
  npm install --no-fund --no-audit </dev/null
  [ -f .env ] || cp .env.example .env

  # Atajo "bot" para no escribir rutas largas en el teclado del teléfono.
  BIN="${PREFIX:-/data/data/com.termux/files/usr}/bin"
  mkdir -p "$BIN"
  printf '#!/data/data/com.termux/files/usr/bin/bash\nexec bash "%s/scripts/android/bot.sh" "$@"\n' "$PWD" > "$BIN/bot"
  chmod +x "$BIN/bot"

  echo "== Comprobando conexiones desde tu teléfono =="
  node dist/index.js diagnostico </dev/null || true

  echo
  echo "Listo. Escribe:"
  echo "  bot iniciar    arranca el reto de 50 USD (simulado)"
  echo "  bot telegram   avisos y control desde Telegram"
  echo "  bot            todos los comandos"
}

main "$@"
