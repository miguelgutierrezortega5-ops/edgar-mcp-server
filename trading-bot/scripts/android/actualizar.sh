#!/data/data/com.termux/files/usr/bin/bash
# Descarga la última versión del bot y la recompila (detenlo antes).
set -e
cd "$(dirname "$0")/../.."
git pull --ff-only
npm install --no-fund --no-audit
echo "Actualizado. Arranca de nuevo con: bash scripts/android/iniciar.sh"
