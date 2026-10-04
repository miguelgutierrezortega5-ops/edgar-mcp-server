# Bot de trading de criptomonedas y divisas

Bot que vigila mercados de cripto y forex, **estudia las huellas que dejan las ballenas**, opera con gestión del riesgo y **se reajusta solo** con datos recientes, validando cada cambio en datos que no ha visto. Funciona **en modo simulado (paper trading) por defecto**, sin claves ni dinero real.

> ⚠️ **Lee esto antes de usarlo con dinero.** El trading automático puede hacerte perder dinero. Los resultados de abajo son históricos: el bot los vuelve a comprobar cada día, pero nada garantiza que se repitan. No es asesoramiento financiero.

## Qué hace

- **Vigila** cada mercado (velas de 1 minuto a 1 día; 3 minutos para las cripto de bajo volumen) y muestra las **huellas de las ballenas**: desplomes con volumen anómalo, bombeos, barridas de stops, absorciones y flujo de compras/ventas agresivas.
- **Opera** con dos estrategias:
  - `capitulacion`, pensada para cripto de bajo volumen;
  - `cruce_medias`, de seguimiento de tendencia.
- **Aprende**: cada 24 h prueba cientos de combinaciones de parámetros con el historial reciente y solo adopta una si también gana en el tramo más reciente, que no se usó para elegirla. Si nada gana, **pone el mercado en pausa** (lo vigila pero no opera).
- **Estudia**: `npm run estudiar` mide qué hizo el precio tras cada huella de ballena, para comprobar si un patrón sigue funcionando.
- **No da nada por sentado**: una capa adaptativa puntúa cada 4 h el resultado reciente de cada estrategia según el contexto del mercado (toxicidad del flujo, liquidez). Usa memoria que se desvanece. Ajusta el tamaño con Kelly y apaga lo que deja de funcionar; si vuelve a funcionar, lo enciende.
- **Lee los futuros de Binance**, cada 5 minutos y por contrato: interés abierto, largos/cortos de los grandes traders y de todas las cuentas, flujo agresivo y financiación. Ver [Futuros](#futuros-de-binance).
- **Usa algoritmos cuantitativos**: VPIN, lambda de Kyle, Amihud, exponente de Hurst, rendimientos logarítmicos, criterio de Kelly y ratio de Sharpe deflactado. Ver [Algoritmos](#algoritmos-y-lo-que-midieron).
- **Se protege** como Freqtrade:
  - tras cerrar una operación, espera 20 velas antes de volver a operar esa moneda;
  - tras 3 stop-loss en una hora, deja de abrir operaciones durante 4 horas (una cascada que no rebota).
- **Elige los pares solo** (opcional): monedas de Binance con 1-8 millones de USD de volumen diario, spread pequeño y al menos 180 días cotizando. Excluye stablecoins y tokens apalancados, y renueva la lista cada 24 h.
- **Se controla desde Telegram**: `/estado`, `/pausa`, `/reanudar`, `/cerrar SIMBOLO|todo`.
- **Se verifica**: `npm run verificar` comprueba que ninguna estrategia mira al futuro (sesgo de anticipación).
- **Limita el riesgo**: arriesga un % fijo por operación, limita el tamaño de cada posición según la liquidez del par, pone stop y objetivo en cada operación y cierra por tiempo. Además deja de operar el resto del día si pierde un 3%, y se detiene por completo si cae un 15% desde su máximo.
- **Ejecuta** en simulado, en cualquier exchange vía [ccxt](https://github.com/ccxt/ccxt) (Binance, Kraken, Bybit, OKX…) o en OANDA para divisas, en cuenta de pruebas o real.
- **Avisa** por Telegram (opcional) y guarda cada operación en `data/trades.csv`.

## Instalación

Necesitas [Node.js 20.12 o superior](https://nodejs.org).

```bash
cd trading-bot
npm install
cp config.example.json config.json
cp .env.example .env             # solo si vas a usar claves o Telegram
```

## Desde el celular (Android)

El bot corre en el propio teléfono con [Termux](https://f-droid.org/packages/com.termux/), una terminal de Linux para Android. Usa tu conexión de México, así que los futuros de Binance llegan en vivo. Es gratis y no necesitas computadora.

1. Instala **Termux desde F-Droid** (la versión de Google Play está abandonada): entra a [f-droid.org/packages/com.termux](https://f-droid.org/packages/com.termux/) y descarga el APK.
2. Abre Termux y pega este comando (tarda unos minutos):
   ```bash
   curl -fsSL https://raw.githubusercontent.com/miguelgutierrezortega5-ops/edgar-mcp-server/ccr-6370af02-zxtdm6/trading-bot/scripts/android/instalar.sh | bash
   ```
   Al final muestra el diagnóstico: "Binance futuros en vivo" debería salir con ✓.
3. Arranca el reto de 50 USD (simulado) con `bot iniciar`. El primer arranque aprende de la historia y puede tardar varios minutos.

El instalador deja el atajo `bot`:

| Comando | Qué hace |
| --- | --- |
| `bot iniciar` | Arranca el bot en segundo plano |
| `bot estado` | Saldo, posiciones y últimas líneas del registro |
| `bot registro` | Registro en vivo (Ctrl+C para salir; Ctrl está en la fila de teclas de Termux) |
| `bot detener` | Lo detiene; lo simulado queda guardado y se retoma al volver a arrancar |
| `bot actualizar` | Descarga la última versión y lo reinicia si estaba en marcha |
| `bot telegram` | Configura avisos y control por Telegram |
| `bot arranque` | Que arranque solo al encender el teléfono (`bot arranque no` lo quita) |

**Para que Android no lo duerma:**

- en Ajustes → Aplicaciones → Termux → Batería, elige "Sin restricciones";
- deja la notificación de Termux activa ("wake lock");
- si aun así se detiene solo (Android 12 o más nuevo cierra procesos en segundo plano), en Android 14 o más nuevo activa Opciones de desarrollador → "Desactivar restricciones de procesos secundarios". Las opciones de desarrollador aparecen al tocar 7 veces el número de compilación en Ajustes → Acerca del teléfono.

El bot solo opera mientras el teléfono está encendido y con conexión. Para que vuelva solo tras un reinicio, instala también **Termux:Boot** desde F-Droid, ábrelo una vez y escribe `bot arranque`.

**Datos móviles:**

- el primer aprendizaje descarga unos 100 MB de historia, así que mejor hazlo con WiFi;
- después, las velas quedan guardadas en `data/velas` y el bot usa unos 50 MB al día.

**Recomendado: avísate y contrólalo por Telegram.** Escribe `bot telegram` y sigue los pasos:

1. en Telegram, habla con @BotFather, usa `/newbot` y pega en Termux el token que te da;
2. abre tu bot nuevo, pulsa "Iniciar" y escríbele cualquier cosa: el asistente detecta tu chat, lo guarda en `.env`, te manda un mensaje de prueba y reinicia el bot si estaba en marcha.

A partir de ahí recibes cada operación en Telegram y puedes escribirle `/estado`, `/pausa`, `/reanudar` o `/cerrar`.

**iPhone:** iOS no permite ejecutar este tipo de programas. La alternativa es un servidor en la nube ubicado en México (Oracle Cloud tiene regiones en Querétaro y Monterrey, AWS y Azure también), que se maneja desde el navegador del teléfono, con Telegram para el día a día. Comprueba al contratar qué incluye el plan gratuito en esas regiones.

## Ejecutarlo desde México (o desde cualquier país donde opere Binance)

Binance responde "451: ubicación restringida" a los equipos de EE. UU. y otros países donde no opera. Desde un equipo en México funcionan los futuros en vivo y las órdenes en Binance (testnet o real). Comprueba qué responde desde tu equipo:

```bash
npm run diagnostico
```

```
✓ Binance datos de mercado (spot): OK
✓ Binance API de órdenes (spot): OK
✓ Binance futuros en vivo: OK
✓ Binance archivo histórico: OK
✓ Yahoo Finance (divisas): OK
```

Pasos en tu computadora (Windows, Mac o Linux):

1. Instala [Node.js 22](https://nodejs.org) y [Git](https://git-scm.com/downloads).
2. Descarga el proyecto y entra al bot:
   ```bash
   git clone https://github.com/miguelgutierrezortega5-ops/edgar-mcp-server.git
   cd edgar-mcp-server/trading-bot
   npm install
   npm run diagnostico
   ```
3. Arranca el reto de 50 USD (simulado): `npm run bot -- --config config.reto50.json`.
4. Opcional: pon `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` en `.env` para recibir avisos y controlarlo desde el teléfono (`/estado`).

El equipo tiene que estar encendido para que el bot opere. Para tenerlo siempre activo, usa un servidor o una Raspberry Pi en México con Docker o pm2 (ver [Tenerlo en marcha 24/7](#tenerlo-en-marcha-247)).

## Uso

```bash
npm run scan        # foto del mercado y huellas de ballenas ahora mismo
npm run estudiar    # qué patrones de ballenas funcionan con datos recientes
npm run aprender    # reajusta parámetros y decide qué mercados operar (2-4 min)
npm run backtest    # cómo le habría ido con la configuración actual (cuenta compartida)
npm run verificar   # comprueba que las estrategias no miran al futuro
npm run diagnostico # qué fuentes y brokers responden desde este equipo
npm run bot         # arranca el bot (vuelve a aprender cada 24 h); Ctrl+C para pararlo
npm run status      # saldo, posiciones, operaciones, aprendizaje y límites
```

| Opción | Qué hace |
| --- | --- |
| `npm run estudiar -- --dias 90` | Estudio con 90 días de historia |
| `npm run estudiar -- --temporalidad 1h` | Estudia los mercados de 1 hora (por defecto, la temporalidad más usada) |
| `npm run backtest -- --dias 150 --mercado CHZ/USDT --operaciones` | Un mercado, con la lista de operaciones |
| `npm run bot -- --once` | Una sola revisión y termina (para cron) |
| `npm run status -- --reanudar` | Reactiva el trading tras una parada por pérdidas |

### Control desde Telegram

Con `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` en `.env`, el bot avisa de cada operación y obedece estos comandos, solo desde tu chat:

| Comando | Qué hace |
| --- | --- |
| `/estado` | Saldo, posiciones con su resultado, operaciones de hoy y pausas activas |
| `/pausa` | Deja de abrir operaciones (las abiertas siguen con su stop y objetivo) |
| `/reanudar` | Quita la pausa manual, la de protecciones y la parada por pérdidas |
| `/cerrar BTC` o `/cerrar todo` | Cierra a mercado |
| `/actualizar` | Instala las mejoras nuevas del bot y lo reinicia con ellas |
| `/informe` | Publica ya el informe detallado para Claude (ver abajo) |
| `/mechas` | Reto 2: saldo, posiciones, qué tan bien acierta (predicción frente a realidad) y cómo van las variantes en la sombra |

Los mensajes enviados mientras el bot estaba apagado se descartan, no se ejecutan.

### Informe diario para Claude

Una vez al día, y cuando escribes `/informe`, el bot manda al chat un archivo `informe-….json` y lo deja fijado, sin sonido. El archivo incluye:

- saldo y posiciones;
- las últimas operaciones;
- pausas;
- parámetros y lo aprendido;
- la capa adaptativa;
- las últimas 400 líneas del registro, que dicen qué señales ignoró y por qué.

No contiene claves ni tokens. Con el token del bot, Claude lee el último informe fijado (`node scripts/leer-informe.mjs`) y aprende de lo que pasa en tu celular, que es la copia con futuros en vivo. Telegram no deja que un bot lea los mensajes que él mismo envió, así que el archivo fijado es la forma de que llegue. Para cambiar la frecuencia, usa `telegram.reportHours` en la configuración; con `0` solo se publica con `/informe`.

### Mejoras nuevas

Cada mejora del bot (estrategias, aprendizajes, correcciones) se publica en la rama de GitHub de la que se instaló. Cada 6 horas el bot mira si hay mejoras nuevas y, si las hay, te avisa por Telegram con la lista. Escribe `/actualizar` para instalarlas: el bot las descarga, se recompila (un par de minutos) y se reinicia solo con la versión nueva. El saldo simulado, las posiciones y lo que el bot aprendió se conservan, porque están en `data/`, que las actualizaciones no tocan. Nada se instala sin tu `/actualizar`, salvo que actives la instalación automática (abajo).

Si una versión nueva no compila, el bot la deshace en el acto y sigue con la anterior. Si compila pero se cae dos veces nada más arrancar, el supervisor vuelve a la anterior y te avisa por Telegram.

**Instalación automática (apagada por defecto).** Con `"updates": { "auto": true, "checkHours": 1 }` en la configuración, el bot instala solo las mejoras nuevas cada hora y te avisa de qué instaló. Solo lo hace mientras ninguna cuenta use dinero real; con dinero real, siempre espera tu `/actualizar`. Una versión que ya falló al arrancar no se reinstala sola hasta que llegue una más nueva.

El reinicio automático lo hace `scripts/android/supervisor.sh`, que arranca `bot iniciar`. Si el bot se cae, el supervisor lo vuelve a arrancar al minuto, y lo deja detenido tras 5 caídas seguidas. Sin supervisor, por ejemplo con `npm run bot`, `/actualizar` instala la versión nueva y pide reiniciar a mano. Desde Termux también se puede con `bot actualizar`.

## Algoritmos y lo que midieron

En este mercado no hay leyes fijas. Cada algoritmo se midió con 150 días de 16 pares de Binance en 3m, separando el periodo antiguo del reciente, y el bot los sigue midiendo:

| Algoritmo | Qué mide | Resultado medido | Cómo lo usa el bot |
| --- | --- | --- | --- |
| **VPIN** (Easley, López de Prado y O'Hara) | Toxicidad del flujo: compras o ventas agresivas de un solo lado, típico de alguien informado | Por sí solo, sin ventaja estable. Las capitulaciones con VPIN alto rindieron más en ambos periodos (+0,4% y +2,0% frente a −0,0% y +1,2%), con pocos casos | Contexto de la capa adaptativa; columna en `scan`; huella en `estudiar` |
| **Lambda de Kyle** | Cuánto mueve el precio cada unidad de volumen agresivo (libro fino, fácil de mover) | Sin ventaja estable por sí sola | Huella en `estudiar` |
| **Amihud** | Iliquidez: movimiento del precio por unidad negociada | Las capitulaciones con iliquidez alta rindieron menos en ambos periodos, con pocos casos | Contexto de la capa adaptativa |
| **Exponente de Hurst** (regresión log-log) | Régimen: tendencial (>0,55), aleatorio o que revierte (<0,45) | La relación con la capitulación **cambió de signo** entre periodos: no es fiable | Solo informativo (`scan`) |
| **Rendimientos logarítmicos y Kelly** | Crecimiento compuesto; tamaño que maximiza el crecimiento logarítmico | — | La capa adaptativa no apuesta si Kelly ≤ 0 |
| **Evidencia con memoria que se desvanece** + bayes empírico | Probabilidad de que un contexto tenga ventaja, dando más peso a lo reciente | En 150 días la ventaja se mantuvo, así que no mejoró el resultado. Es un seguro: con 30 días de memoria cuesta ~0,4%; con 10 días costaba 3% | Escala o apaga cada contexto |
| **Ratio de Sharpe deflactado** (Bailey y López de Prado) | Si la mejor de N combinaciones es buena o solo suerte | La "mejor" combinación de 216 dio 0,42 en capitulación y 0,08 en divisas: probablemente suerte | El aprendizaje solo adopta parámetros nuevos con ≥ 0,9 |

## Reto: 50 USD

`config.reto50.json` simula una cuenta de 50 USD en Binance:

- 12 pares de bajo volumen en 3m;
- orden mínima de 5 USD, como Binance;
- sin gastar más efectivo del que hay, porque en spot no hay apalancamiento.

```bash
npm run bot -- --config config.reto50.json      # estado: npm run status -- --config config.reto50.json
```

Antes de arrancarlo se midió qué tamaño de apuesta da más opciones de convertir 50 en 200-250 USD. Primero se probó cada nivel con los últimos 150 días. Después se armaron 10.000 años posibles a partir de días reales tomados al azar (enteros, para no romper los días de cascada):

| Nivel de riesgo | 150 días reales | P(llegar a 250 en un año) | P(caer a 25) | Mediana al año |
| --- | --- | --- | --- | --- |
| **Diversificado: 1% por operación, 12,5% por posición, 8 posiciones** (el del reto) | **54,01 USD (+8,0%)**, caída máxima 2% | 0% | 0% | 60 USD |
| Prudente: 1%, 25%, 4 posiciones | 53,87 USD (+7,7%) | 0% | 0% | 59 USD |
| Media: 2%, 50%, 4 posiciones | 48,52 USD (−3,0%) | 0% | 0% | 46 USD |
| Alta: 3%, 100%, 3 posiciones | 46,51 USD (−7,0%) | 0% | 1,4% | 42 USD |
| Muy alta: 5%, 100%, 2 posiciones | 44,39 USD (−11,2%) | 0% | 4,8% | 38 USD |
| Todo dentro: 10%, 100%, 1 posición | 45,93 USD (−8,1%) | 0% | 4,3% | 41 USD |

**Lo que enseñó:**

- **Más riesgo empeora el resultado.** La ventaja está en muchas apuestas pequeñas y repartidas. Si se concentra, un solo día de cascada con 2 o 3 stops se come semanas de ganancia, y las protecciones paran el bot justo antes de los rebotes.
- **Con la ventaja medida, convertir 50 en 250 no es realista**: ningún nivel lo consiguió en un año simulado, y forzarlo solo aumenta la probabilidad de perder.

El reto sigue en simulación para medir la ventaja con el mercado de ahora.

## Reto 2: cazador de mechas (50 USD, operaciones de minutos)

Una segunda cuenta simulada de 50 USD, aparte del reto 1, que opera altcoins en futuros de Binance con órdenes de 1 minuto, comprando y vendiendo en corto. Corre en el mismo bot y el mismo Telegram (`/mechas`), y te avisa al entrar (precio, objetivo y stop) y al salir de cada operación. En su primera operación publica además un informe fijado para que Claude la revise. Se enciende con `"mechas": { "enabled": true }` y ya viene encendido en `config.reto50.json`.

**Cómo opera.** Cada minuto deja, en cada moneda, una orden de compra por debajo del precio y una de venta en corto por encima. La distancia es de 4 veces la volatilidad de 15 minutos de la moneda, normalmente entre 2% y 6%. Es tu escalera de "compro si baja a 2.9, vendo si sube a 3.1", calculada para cada moneda según cuánto se mueve. Si una mecha (una barrida de stops o un libro de órdenes vacío por un instante) llega a la orden, entra:

- el objetivo es volver al precio de antes de la mecha;
- el stop está a la misma distancia más allá de la entrada;
- si en 30 minutos no pasa nada, sale.

Las órdenes quedan esperando, así que la entrada ocurre en el segundo exacto de la mecha, aunque el bot revise una vez por minuto.

Si el celular se duerme, se queda sin red o se reinicia, en esos minutos no hay órdenes; si va atrasado más de 15 segundos en un minuto, tampoco la pone, porque una orden real se habría perdido el principio de esa vela. `/mechas` dice cuántos minutos de hoy se quedaron sin órdenes y el informe diario los guarda por día, para distinguir "el mercado no dio mechas" de "el celular no estaba". Si se queda sin conexión, espera a tener las velas de esos minutos y los repasa, para que ningún stop ni objetivo de una posición abierta se salte.

**Vigilando a las grandes.** Si BTC, ETH o SOL cayeron más de 0.2% en los últimos 5 minutos, no pone compras, porque una mecha durante una caída de las grandes suele seguir bajando. Del mismo modo, si alguna subió más de 0.2%, no pone ventas en corto.

**Qué monedas.** Cada semana elige las 12 altcoins más volátiles de los últimos 30 días entre los futuros con 20 M a 1.5 B USD de volumen diario y al menos 60 días de historia. Deja fuera BTC, ETH, SOL, BNB, XRP, monedas estables, acciones y metales.

**Cómo aprende y se corrige.** Antes de cada orden calcula, para compras y ventas por separado, la probabilidad de ganar y la ganancia media tras comisiones, con lo ocurrido en las últimas semanas (cada día pesa menos que el anterior, con vida media de 30 días). Opera un lado solo si gana más del 50% de las veces, y lo pasa a "solo observa" cuando hay evidencia de que pierde dinero: probabilidad de que su media tras comisiones sea positiva por debajo del 30%. Entre medias opera con un tamaño menor cuanto más duda. En "solo observa" sigue registrando qué habría pasado y vuelve a operar cuando los números lo justifican. `/mechas` muestra la predicción frente a la realidad. Al principio manda el backtest, que cuenta como 10 operaciones (media +0.3%, 60% ganadoras: lo medido de marzo a septiembre).

Antes pausaba con la simple duda (confianza menor al 60%). En las pruebas, eso pausó las compras justo antes de sus mejores rachas en los dos periodos. La regla actual sigue pausando los cortos que perdían en marzo-mayo.

**Variantes en la sombra.** Además de la regla con la que opera (orden a 4σ, objetivo 1×, stop 1×, 30 minutos), el bot sigue cada minuto, sin dinero, 12 variantes en las mismas monedas: órdenes a 3σ, 4σ o 5σ, stop de 1× o 2× y límite de 30 o 60 minutos. Anota cuánto habría ganado cada una por día. Si tras al menos 60 días una variante supera claramente a la activa (ventaja con z ≥ 3, unas tres veces su margen de error) y gana dinero, el bot cambia ese lado a ella y te avisa por Telegram (🔧). `/mechas` y el informe diario muestran cómo va cada una.

La exigencia es alta a propósito. En la prueba, elegir la variante que mejor iba tras unas semanas acertaba tan a menudo como fallaba, porque la que gana un mes casi no anticipa la del siguiente (correlación 0.13 a 0.39). Con esta regla estricta no hubo ningún cambio en 6 meses de prueba: no estropea nada y solo actúa ante un cambio duradero del mercado.

**Cuenta.** Cada orden usa el 15% del saldo (mínimo 5 USD) y el aprendizaje la reduce cuando duda. Como máximo hay 4 posiciones a la vez, y se reserva margen con apalancamiento 10 para las órdenes en espera. Las comisiones son las de futuros: 0.02% al poner la orden y 0.05% al ejecutar a mercado, más 0.1% de deslizamiento en los stops.

**Lo que midió el estudio** (velas de 1 minuto de futuros de junio a septiembre de 2026, 94 altcoins):

| Hallazgo | Resultado |
| --- | --- |
| Rejilla clásica (comprar y vender a escalones fijos, hacia los dos lados) | Pierde tras comisiones o queda en cero, y cambia de signo entre periodos |
| Órdenes cerca del precio (1.5 a 2 veces la volatilidad) | Ganan el 60–79% de las veces pero **pierden** dinero: los aciertos son pequeños y los fallos grandes. Ganar más del 50% no basta |
| Compras en mecha a 4 veces la volatilidad | +0.66% / +0.48% por operación (jun-jul / ago-sep) en las monedas del estudio. Entradas al azar con las mismas salidas: −0.17% / −0.14% |
| La misma regla en 14 monedas que no estaban en el estudio | 0% por operación: el primer resultado dependía de qué monedas se eligieron |
| Elegir cada mes las 12 más volátiles del mes anterior (sin mirar al futuro) | Compras +0.35% / +0.80% / +0.91% (julio / agosto / septiembre), ventas en corto +0.56% / +0.42% / +0.18%, con las grandes tranquilas |
| Elegir las monedas donde la estrategia ganó más el mes anterior | No se mantiene (−0.22% en septiembre) |
| Mechas mientras BTC cae más de 0.3% en ese minuto | −1.71% por operación en ago-sep: son cascadas, no mechas |
| Cuenta de 50 USD, jul-sep, orden del 20%, compras y ventas | 81.85 USD (+64%), caída máxima −11%. Solo compras: 68.34 USD (+37%), caída −6.5% |
| Esta versión del bot (`npm run mechas`), septiembre con las monedas elegidas para ese mes | Compras: 68 operaciones, 71% ganadoras, +0.91%. Ventas: 38 operaciones, +0.67%; al final del mes el bot las pasó a "solo observa" porque se habían vuelto negativas. Cuenta: 56.79 USD (+13.6%), caída −4.2% |
| **Meses que no se usaron para elegir nada (marzo a mayo de 2026)**, el bot completo, monedas elegidas cada mes con el mes anterior | Mucho más flojo. Compras +0.12% por operación (60% ganadoras); ventas −0.01%, y el bot dejó en observación 110 ventas que habrían perdido −0.26% de media. Cuenta: 50.77 USD (+1.5% en 3 meses), caída −6.7%. Sin aprendizaje: 50.56 USD con caída −11.1% |
| Ese mismo bot de julio a septiembre | 66.79 USD (+34%), caída −8.9%. Sin aprendizaje: 71.74 USD. Con la regla de pausa anterior: 61.33 USD |
| **Otros meses sin usar (diciembre de 2025 a febrero de 2026)**, igual que arriba | **Perdió**: 47.58 USD (−4.8% en 3 meses, los tres meses en rojo), caída −5.4%. Compras −0.12% por operación con 66% ganadoras (muy poco para pausarlas); ventas −1.05% en 18 operaciones y luego en observación. Ninguna variante de la pausa del aprendizaje lo evitaba |
| Stop de 2× y 60 minutos (lo mejor de julio a septiembre entre 192 combinaciones) | En marzo a mayo fue **peor** que la regla actual (44.98 frente a 49.19 USD sin aprendizaje): era suerte de esos meses. No se usa |

Ojo: elegí la distancia, el objetivo y el stop viendo julio a septiembre; en marzo a mayo rindió mucho menos y de diciembre a febrero perdió. Lo honesto es esperar poco: plano o en rojo en meses tranquilos y bueno solo cuando hay muchas mechas. Por eso el bot mide cada operación y se corrige solo. Las mechas son pocas: una o dos al día por moneda en las semanas agitadas, y cero en las tranquilas.

Probarlo con datos recientes: `node dist/index.js mechas --config config.reto50.json --dias 14`. Con `--monedas BEAT,TUT` usa esas monedas y con `--hasta 2026-09-30` termina en esa fecha. Al final muestra también cómo habrían ido las variantes en la sombra en esos días (con pocos días la z sale alta por azar; por eso el bot exige 60).

**Datos móviles.** El bot consulta 15 velas por minuto (12 monedas y las 3 grandes): unos 30 MB al día más.

## Futuros de Binance

| Dato | Qué indica |
| --- | --- |
| Interés abierto (OI) | Cuántos contratos hay abiertos. Si sube de golpe, entra apalancamiento; si cae de golpe, hay liquidaciones o cierres |
| Largos/cortos de los grandes traders | Posición de las ballenas: el 20% de cuentas con más margen, por número de cuentas y por tamaño |
| Largos/cortos de todas las cuentas | Hacia dónde está cargada la multitud |
| Flujo agresivo en futuros | Compras frente a ventas a mercado |
| Financiación | Lo que pagan los largos a los cortos (o al revés): mide cuán cargado está un lado |

**De dónde salen:**

- **Historia**: el archivo público de Binance (`data.binance.vision`), con días completos hasta ayer, accesible desde cualquier país. Se guarda en `data/futuros/`.
- **Últimas horas**: la API de futuros (`fapi.binance.com`), disponible en México pero no en EE. UU. Si no responde, el bot sigue con el archivo, y el día en curso queda sin datos de futuros.
- **Liquidaciones individuales**: ya no se publican en el archivo histórico.

**Lo que se midió** (150 días, 15 pares con contrato; DODO no tiene):

| Lectura | Después | ¿Se repite? |
| --- | --- | --- |
| **OI sube ≥3% en 30 min** (entra apalancamiento de golpe) | **−0,2% a −0,6% en 4 h**, frente a −0,09% y +0,12% de referencia | **Sí, en ambos tramos**, suba o baje el precio en ese momento. Se confirmó también en los últimos 60 días |
| OI cae, extremos de ballenas o de la multitud, financiación negativa | Como la referencia | No |
| Capitulación con OI cayendo (liquidaciones) frente a OI estable | +0,32% frente a −0,17% en el tramo antiguo; +1,07% frente a +1,46% en el reciente | **No: se invierte**. No se usa como filtro |

**Cómo los usa el bot:**

- `scan` muestra el estado de futuros de cada moneda.
- `estudiar` mide sus huellas con datos nuevos.
- La capa adaptativa registra cómo le va a cada estrategia según el estado de futuros.

Usar esos contextos para cambiar el tamaño de las posiciones **empeoró** el resultado en la prueba sin mirar al futuro: factor de beneficio 1,67 frente a 1,85 sin contextos y 1,82 solo con la evidencia del grupo. Por eso está desactivado (`adaptive.useContexts: false`). Se puede activar si algún día los datos lo respaldan.

## Comparación con otros bots

| | Este bot | Freqtrade | Hummingbot | Jesse | OctoBot | 3Commas / Pionex |
| --- | --- | --- | --- | --- | --- | --- |
| Estrategias de ballenas (cascadas, bombeos, barridas) con estudio propio | **Sí** | Se programan a mano | No | Se programan a mano | No | No |
| Aprendizaje con validación en datos no vistos y pausa automática | **Sí, cada 24 h** | Hyperopt manual | No | Optimización manual | No | No |
| Backtest de cartera (cuenta compartida) | Sí | Sí | No | Sí | Parcial | No |
| Protecciones (enfriamiento, racha de stops, pérdidas) | Sí | Sí | No | No | Parcial | Parcial |
| Lista dinámica de pares | Sí (Binance) | Sí (cualquier exchange) | No | No | Parcial | Sí |
| Detección de sesgo de anticipación | Sí | Sí | No | No | No | No |
| Control por Telegram | Sí | Sí | Sí | No | Sí | Sí |
| Stop-loss en el exchange (protege con el bot apagado) | Solo OANDA | Sí | — | Sí | Sí | Sí |
| Interfaz web | No | Sí | Sí | Sí | Sí | Sí |
| Market making / arbitraje | No | No | **Sí** | No | No | No |
| Grid / DCA | No | Con estrategias | Sí | No | Sí | **Sí** |
| Datos de futuros (interés abierto, largos/cortos, financiación) | Sí, medidos | Sí | Sí | Sí | Parcial | Parcial |
| Operar futuros y apalancamiento | No | Sí | Sí | Sí | Sí | Sí |

Lo que falta y por qué:

- **Stop-loss en el exchange para cripto**: es lo siguiente. No pude probarlo porque Binance bloquea este servidor.
- **Interfaz web**: Telegram cubre el control diario.
- **Grid y DCA**: promediar a la baja choca con la gestión del riesgo, y los datos no los respaldan en estos pares.
- **Market making**: es otro negocio, que necesita baja latencia y comisiones de creador de mercado.

## Lo que el bot ha aprendido de las ballenas

Estudio con 16 pares de Binance de 1 a 8 millones de USD de volumen diario y velas de 3 minutos durante 150 días. Los patrones se buscaron en el primer 60% del periodo y se validaron en el 40% restante. Rentabilidad media después de la señal:

| Huella | Qué suele ser | Después | ¿Se repite? |
| --- | --- | --- | --- |
| **Desplome en cascada**: −3% en 30 min con volumen ×4 **mientras BTC cae** | Cascada de liquidaciones que arrastra a todo el mercado | **+2,1% una hora después; sube el 89% de las veces** (últimos 60 días). Operaciones simuladas con stop y comisiones: +0,4% y +1,3% por operación en los dos tramos | Sí, en ambos tramos y en 12 de 12 pares |
| Desplome aislado: igual, pero con BTC tranquilo | Venta real de esa moneda (noticias, desbloqueos, una ballena saliendo) | Operaciones simuladas: −0,4% y −0,2% por operación | Pierde en ambos tramos |
| Bombeo: +3% en 30 min con volumen ×4 | Pump & dump | −0,4% a −0,7% una hora después | Sí: nunca comprar ahí |
| Barrida de máximos: supera el máximo reciente y cierra por debajo | Trampa alcista | Negativo | Sí |
| Ruptura con compras agresivas | Perseguir la subida | ≈ 0% | Las rupturas se deshacen |
| Barrida de mínimos con volumen | Caza de stops | +0,1% en una hora, +0,25% en cuatro | Positivo pero por debajo de las comisiones |

Conclusiones que usa la estrategia `capitulacion`:

1. Comprar el desplome **solo si BTC también cae** (`marketDropPct`).
2. **Stop amplio**, 1,5 ATR por debajo del mínimo del desplome: los stops ajustados son justo los que barren las ballenas. Con 0,5 ATR la mayoría de configuraciones pierde.
3. **Objetivo**: recuperar todo lo que cayó. **Salida por tiempo** a las 40 velas (2 horas).
4. **Tamaño limitado por la liquidez**: como máximo el 20% de lo que se negocia en una vela típica (`maxBarVolumePct`), para no mover el precio en pares pequeños.

Los desplomes llegan en racimos: un mismo día de caída activa una docena de monedas a la vez. Por eso el aprendizaje mide los resultados **por día**, no por operación. Si no, un solo día parecería mucha evidencia.

## Resultados del backtest

El backtest simula **una cuenta compartida** por todos los mercados de cripto (y otra para divisas), como el bot en vivo. El límite de 4 posiciones y las protecciones deciden cuáles de las señales simultáneas se operan. Configuración de ejemplo, del 4-5-2026 al 1-10-2026, 10.000 USD, comisiones y deslizamiento incluidos:

| Simulación (12 pares de bajo volumen, 3m, `capitulacion`) | Factor de beneficio | Resultado | Caída máxima |
| --- | --- | --- | --- |
| Cada mercado con su propia cuenta (método anterior, optimista) | 2,17 | +1,7% sobre 120.000 | 2,6% |
| Una cuenta compartida, sin protecciones | 1,36 | +5,6% | 5,3% |
| **Una cuenta compartida con protecciones** (configuración por defecto) | **1,88** | **+7,7%** | **2,4%** |

La simulación por mercado sobrestimaba la ventaja. En los días de cascada se disparan una docena de monedas a la vez, y solo caben 4 posiciones.

`cruce_medias` pierde en BTC/ETH en 1h (por eso ya no está en el ejemplo) y en divisas con los parámetros por defecto (−14% en 150 días, parada por pérdidas). En vivo, el aprendizaje se ejecuta antes de operar y ajusta o pausa esos mercados.

**Ojo:** el filtro de BTC lo descubrí mirando estos mismos 150 días, así que este backtest **no es una prueba limpia**. La prueba de verdad son los datos futuros: por eso el bot revalida cada 24 h y pausa lo que deja de funcionar.

## Cómo aprende

1. Agrupa los mercados que comparten estrategia y temporalidad. En bajo volumen, una moneda sola da muy pocas operaciones para fiarse.
2. Toma el historial reciente (`learning.bars`, unos 150 días en 3m) y lo divide: el 70% más antiguo para buscar y el 30% más reciente para validar.
3. Prueba cada combinación de parámetros de la estrategia y elige la de mejor resultado diario, ajustado por su variabilidad.
4. Comprueba esa combinación en el 30% reciente:
   - **si gana**, la adopta;
   - si no gana pero los parámetros actuales sí, **los mantiene**;
   - si nada gana, **pausa** el grupo;
   - si hay pocos datos, no cambia nada.
5. Guarda el resultado en `data/aprendizaje.json` y añade una línea al diario `data/aprendizaje.log`, para ver cómo evoluciona.

Mientras haya posiciones abiertas, el bot pospone el aprendizaje (hasta un día) para no dejarlas sin vigilar durante esos minutos.

## Modos de operación

| Modo | Configuración | Dinero |
| --- | --- | --- |
| **Simulado** (por defecto) | `crypto.broker: "paper"`, `forex.broker: "paper"`: una cuenta para cripto y otra para divisas | Ficticio |
| **Red de pruebas** | `crypto.broker: "exchange"`, `sandbox: true` + claves de la [testnet de Binance](https://testnet.binance.vision) | Ficticio |
| **OANDA demo** | `forex.broker: "oanda"`, `oandaEnv: "practice"` | Ficticio |
| **Real** | `sandbox: false` u `oandaEnv: "live"` **y** `CONFIRMAR_DINERO_REAL=si` en `.env` | **Real** |

En un exchange real:

- crea la clave de API **solo con permiso de trading, nunca de retirada**;
- usa una subcuenta dedicada;
- recuerda que **los stops de cripto los vigila el bot**: debe estar encendido.

Los precios de cripto salen de `data-api.binance.vision`, el servicio público de datos de Binance, accesible desde cualquier país. Incluye el volumen de compras agresivas. Las órdenes van a `api.binance.com`, disponible en México.

## Configuración

`config.json` (ver `config.example.json`):

| Clave | Qué es |
| --- | --- |
| `pollSeconds` | Cada cuántos segundos revisa los mercados (20 con velas de 3m) |
| `paper` | Capital simulado, comisión y deslizamiento de cripto (%), spread de divisas (pips) |
| `risk.riskPerTradePct` | % del capital que se pierde si salta el stop (1) |
| `risk.maxNotionalPct` | Tamaño máximo de una posición en % del capital: cripto 25, divisas 500 (apalancamiento 5:1) |
| `risk.maxBarVolumePct` | Tamaño máximo como % de lo negociado en una vela típica (20). Protege en pares de poco volumen |
| `risk.maxOpenPositions`, `dailyLossLimitPct`, `maxDrawdownPct` | 4 posiciones; parar el día al −3%; detenerse al −15% desde el máximo |
| `strategies` | Parámetros por defecto de cada estrategia (ver abajo) |
| `learning` | `enabled`, cada cuántas horas (`everyHours`), historial (`bars`, `maxDays`), % de validación (`testPct`), mínimos de operaciones y factor de beneficio |
| `crypto.exchange` | `binance` (por defecto), `kraken`, `bybit`, `okx`… |
| `crypto.reference` | Mercado que indica si cae todo el mercado (`BTC/USDT`) |
| `crypto.autoPairs` | `enabled`, volumen diario (`minVolumeUsd`, `maxVolumeUsd`), `maxSpreadPct`, `minAgeDays`, `minTrades`, `max`, `timeframe`, `strategy`, `refreshHours`, `exclude` |
| `crypto.futures` | Datos de futuros de Binance (`true`) |
| `adaptive` | `enabled`, cada cuántas horas (`everyHours` 4), ventana (`windowDays` 60), memoria (`halfLifeDays` 30), peso del grupo (`priorTrades` 5), probabilidades mínima (0,55) y para tamaño completo (0,7), `useContexts` (`false`: decide la evidencia del grupo) |
| `protections` | `cooldownBars` (20), `stopGuardCount` (3) stops en `stopGuardMinutes` (60) → pausa de `stopGuardPauseMinutes` (240) |
| `crypto.markets`, `forex.markets` | `{ "symbol": "CHZ/USDT", "timeframe": "3m", "strategy": "capitulacion", "params": { … } }` |

Parámetros de `capitulacion`:

| Parámetro | Por defecto | Qué es |
| --- | --- | --- |
| `lookback`, `dropPct` | 10, 3 | Caída mínima (%) en esas velas |
| `relVolume`, `volumeAvg` | 4, 50 | Volumen mínimo frente a la media de esas velas |
| `marketDropPct` | 0,5 | Caída mínima de BTC en las mismas velas (0 = sin filtro) |
| `stopAtr`, `atrPeriod` | 1,5, 14 | Stop: este múltiplo del ATR bajo el mínimo del desplome |
| `retrace` | 1 | Objetivo: fracción de la caída a recuperar (0 = sin objetivo) |
| `maxBars` | 40 | Cierre por tiempo, en velas |

Parámetros de `cruce_medias`: `fastEma` 20, `slowEma` 50, `trendEma` 200, `rsiPeriod` 14, `rsiOverbought` 70, `rsiOversold` 30, `atrPeriod` 14, `stopAtr` 2, `takeProfitAtr` 4, `trailingStopAtr` 0.

El estado se guarda en `data/`. Para empezar de cero, borra esa carpeta.

## Tenerlo en marcha 24/7

Con Docker (no lo pude probar aquí porque no hay Docker disponible):

```bash
docker build -t trading-bot .
docker run -d --restart unless-stopped --name trading-bot \
  -v "$PWD/config.json:/app/config.json:ro" -v "$PWD/.env:/app/.env:ro" -v "$PWD/data:/app/data" trading-bot
docker logs -f trading-bot
```

O con pm2:

```bash
npm install -g pm2
pm2 start dist/index.js --name trading-bot -- run
pm2 logs trading-bot
```

## Limitaciones

- El backtest simula comisiones, deslizamiento y spread, pero no la profundidad real del libro de órdenes ni caídas del exchange.
- En pares de poco volumen, el límite de liquidez deja posiciones pequeñas. Esta estrategia no escala a cuentas grandes.
- Yahoo Finance (divisas) es un servicio no oficial y solo para uso personal.

## Desarrollo

```bash
npm test          # compila y ejecuta las pruebas, sin conexión
```

| Archivo | Qué contiene |
| --- | --- |
| `strategies/` | Estrategias (`capitulation.ts`, `ema.ts`) y su interfaz |
| `research.ts` | Huellas de ballenas y estudio de eventos |
| `learn.ts` | Aprendizaje con validación en datos no vistos |
| `engine.ts`, `backtest.ts` | Bucle del bot y backtest de cartera, con las mismas reglas |
| `data/futures.ts`, `data/zip.ts` | Futuros de Binance (archivo público y API) |
| `quant.ts`, `adaptive.ts` | Algoritmos cuantitativos (VPIN, Kyle, Amihud, Hurst, Kelly, Sharpe deflactado) y capa adaptativa |
| `protections.ts`, `pairs.ts`, `verify.ts` | Protecciones, lista dinámica de pares, detección de sesgo de anticipación |
| `risk.ts`, `stops.ts` | Tamaño de posición, límites, stops, objetivo y stop dinámico |
| `brokers/`, `data/` | Simulado, exchanges (ccxt), OANDA; datos de Binance, ccxt, Yahoo y OANDA |

Para añadir una estrategia, crea un archivo en `strategies/` con la interfaz de `strategies/types.ts`: parámetros, rejilla de aprendizaje, `prepare` y `evaluate`. Después regístrala en `strategy.ts`.
