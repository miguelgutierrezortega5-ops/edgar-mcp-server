#!/data/data/com.termux/files/usr/bin/bash
# Atajo para manejar el bot desde Termux (instalar.sh lo deja como el comando "bot").
D="$(cd "$(dirname "$0")" && pwd)"
case "${1:-}" in
  iniciar | estado | detener | actualizar)
    s="$1"; shift; exec bash "$D/$s.sh" "$@" ;;
  registro)
    echo "Registro en vivo (Ctrl+C para salir):"; exec tail -n 30 -f "$D/../../data/bot.log" ;;
  telegram)
    cd "$D/../.." && node scripts/android/telegram.mjs || exit 1
    if pgrep -f "dist/index.js run" >/dev/null; then bash "$D/detener.sh" && bash "$D/iniciar.sh"; fi ;;
  arranque)
    if [ "${2:-si}" = no ]; then rm -f "$HOME/.termux/boot/trading-bot"; echo "Ya no arrancará al encender el teléfono."; exit 0; fi
    mkdir -p "$HOME/.termux/boot"
    printf '#!/data/data/com.termux/files/usr/bin/sh\ntermux-wake-lock\nbash "%s/iniciar.sh"\n' "$D" > "$HOME/.termux/boot/trading-bot"
    chmod +x "$HOME/.termux/boot/trading-bot"
    echo "Listo. Falta instalar Termux:Boot desde F-Droid y abrirlo una vez; desde entonces el bot arranca al encender el teléfono."
    echo "Para quitarlo: bot arranque no" ;;
  *)
    cat <<'AYUDA'
Comandos:
  bot iniciar      arranca el bot en segundo plano (reto de 50 USD, simulado)
  bot estado       saldo, posiciones y últimas líneas del registro
  bot registro     registro en vivo (Ctrl+C para salir)
  bot detener      lo detiene (lo simulado queda guardado)
  bot actualizar   descarga la última versión y lo reinicia si estaba en marcha
  bot telegram     configura avisos y control por Telegram
  bot arranque     que arranque solo al encender el teléfono (bot arranque no, para quitarlo)
AYUDA
    ;;
esac
