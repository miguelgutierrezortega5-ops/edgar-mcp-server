#!/data/data/com.termux/files/usr/bin/bash
# Mantiene el bot en marcha (iniciar.sh lo lanza): lo reinicia tras /actualizar (código 75) y, si se
# cae, lo vuelve a arrancar al minuto; tras 5 caídas seguidas en menos de 5 minutos cada una, se rinde.
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
      if [ "$FALLOS" -ge 5 ]; then echo "[supervisor] El bot falló 5 veces seguidas; lo dejo detenido. Revisa este registro."; exit 1; fi
      echo "[supervisor] El bot se detuvo (código $CODIGO); lo reinicio en 60 s."
      sleep 60 ;;
  esac
done
