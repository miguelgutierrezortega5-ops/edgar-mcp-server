#!/data/data/com.termux/files/usr/bin/bash
# Descarga la última versión del bot, la recompila y lo reinicia si estaba en marcha.
set -e
cd "$(dirname "$0")/../.."
ACTIVO=0
if pgrep -f "dist/index.js run" >/dev/null; then ACTIVO=1; bash scripts/android/detener.sh; fi
git pull --ff-only
npm install --no-fund --no-audit
echo "Actualizado."
if [ "$ACTIVO" = 1 ]; then bash scripts/android/iniciar.sh; else echo "Arráncalo con: bot iniciar"; fi
