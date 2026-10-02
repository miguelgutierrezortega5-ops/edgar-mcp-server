#!/data/data/com.termux/files/usr/bin/bash
# Descarga la última versión del bot, la recompila y lo reinicia si estaba en marcha.
# (También se puede desde Telegram con /actualizar.) Va dentro de main porque git pull reescribe este archivo.
set -e
main() {
  cd "$(dirname "$0")/../.."
  local activo=0
  if pgrep -f "android/supervisor.sh|dist/index.js run" >/dev/null; then activo=1; bash scripts/android/detener.sh; fi
  git pull --ff-only
  npm install --no-fund --no-audit
  echo "Actualizado: $(git log -1 --format='%h del %cs: %s')"
  if [ "$activo" = 1 ]; then bash scripts/android/iniciar.sh; else echo "Arráncalo con: bot iniciar"; fi
}
main "$@"
