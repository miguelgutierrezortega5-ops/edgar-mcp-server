#!/data/data/com.termux/files/usr/bin/bash
# Detiene el bot (las posiciones simuladas quedan guardadas y se retoman al volver a arrancar).
# Primero el supervisor, para que no lo vuelva a arrancar.
pkill -f "android/supervisor.sh"
if pkill -f "dist/index.js run"; then echo "Bot detenido."; else echo "El bot no estaba en marcha."; fi
termux-wake-unlock 2>/dev/null || true
