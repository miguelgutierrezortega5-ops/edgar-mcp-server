#!/data/data/com.termux/files/usr/bin/bash
# Arranca el bot en segundo plano y evita que Android lo duerma. Uso: iniciar.sh [config]
cd "$(dirname "$0")/../.." || exit 1
CONFIG="${1:-config.reto50.json}"
if pgrep -f "dist/index.js run" >/dev/null; then
  echo "El bot ya está en marcha. Estado: bot estado"
  exit 0
fi
termux-wake-lock 2>/dev/null || true
mkdir -p data
nohup node dist/index.js run --config "$CONFIG" >> data/bot.log 2>&1 &
echo "Bot en marcha con $CONFIG (registro: data/bot.log)."
echo "Estado: bot estado   Registro en vivo: bot registro   Detener: bot detener"
