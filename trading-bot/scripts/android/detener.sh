#!/data/data/com.termux/files/usr/bin/bash
# Detiene el bot (las posiciones simuladas quedan guardadas y se retoman al volver a arrancar).
pkill -f "dist/index.js run" && echo "Bot detenido." || echo "El bot no estaba en marcha."
termux-wake-unlock 2>/dev/null || true
