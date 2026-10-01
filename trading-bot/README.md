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

## Uso

```bash
npm run scan        # foto del mercado y huellas de ballenas ahora mismo
npm run estudiar    # qué patrones de ballenas funcionan con datos recientes
npm run aprender    # reajusta parámetros y decide qué mercados operar (2-4 min)
npm run backtest    # cómo le habría ido con la configuración actual (cuenta compartida)
npm run verificar   # comprueba que las estrategias no miran al futuro
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

Los mensajes enviados mientras el bot estaba apagado se descartan, no se ejecutan.

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
