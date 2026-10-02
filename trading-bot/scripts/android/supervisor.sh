#!/data/data/com.termux/files/usr/bin/bash
# Mantiene el bot en marcha (iniciar.sh lo lanza): lo reinicia tras /actualizar (código 75) y, si se
# cae, lo vuelve a arrancar al minuto; tras 5 caídas seguidas en menos de 5 minutos cada una, se rinde.
# Si una versión recién instalada se cae dos veces nada más arrancar, vuelve a la anterior
# (.actualizacion-previa, que el bot borra tras 10 minutos funcionando) y marca la fallida.
cd "$(dirname "$0")/../.." || exit 1
export BOT_SUPERVISOR=1
FALLOS=0
while true; do
  INICIO=$(date +%s)
  node dist/index.js run --config "$1"
  CODIGO=$?
  case "$CODIGO" in
    0) exit 0 ;;
    75) echo "[supervisor] Reiniciando con la versión nueva…"; FALLOS=0 ;;
    *)
      [ $(( $(date +%s) - INICIO )) -ge 300 ] && FALLOS=0
      FALLOS=$((FALLOS + 1))
      if [ "$FALLOS" -ge 2 ] && [ -f .actualizacion-previa ]; then
        PREVIA=$(cat .actualizacion-previa)
        NUEVA=$(git rev-parse --short HEAD)
        echo "[supervisor] La versión nueva ($NUEVA) no logra arrancar; vuelvo a la anterior…"
        git rev-parse HEAD > .actualizacion-fallida
        if git reset --hard --quiet "$PREVIA" && npm install --no-fund --no-audit </dev/null >/dev/null 2>&1; then
          echo "La versión $NUEVA se cayó al arrancar y volví a la anterior ($(git rev-parse --short HEAD))." > .actualizacion-aviso
        fi
        rm -f .actualizacion-previa
        FALLOS=0
        continue
      fi
      if [ "$FALLOS" -ge 5 ]; then echo "[supervisor] El bot falló 5 veces seguidas; lo dejo detenido. Revisa este registro."; exit 1; fi
      echo "[supervisor] El bot se detuvo (código $CODIGO); lo reinicio en 60 s."
      sleep 60 ;;
  esac
done
