#!/data/data/com.termux/files/usr/bin/bash
# Muestra el saldo, las posiciones y las últimas líneas del registro. Uso: estado.sh [config]
cd "$(dirname "$0")/../.." || exit 1
if pgrep -f "dist/index.js run" >/dev/null; then echo "Bot: en marcha"; else echo "Bot: detenido (bot iniciar para arrancarlo)"; fi
node dist/index.js status --config "${1:-config.reto50.json}"
echo; echo "Últimas líneas del registro:"; tail -n 15 data/bot.log 2>/dev/null
