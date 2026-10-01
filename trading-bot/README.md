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
npm run backtest    # cómo le habría ido con la configuración actual
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

Configuración de ejemplo, del 4-5-2026 al 1-10-2026, 10.000 USD por mercado, comisiones y deslizamiento incluidos:

| Estrategia y mercados | Resultado |
| --- | --- |
| `capitulacion`, 12 pares de bajo volumen en 3m | **Gana en los 12**: factor de beneficio de 1,47 a 7,62 y caída máxima ≤ 2,6%. Pocas operaciones (8-35 por par) y posiciones pequeñas por el límite de liquidez: +0,5% a +4,4% por par |
| `cruce_medias`, BTC y ETH en 1h | Pierde (−1,1% y −3,8%). El aprendizaje los pone en pausa |
| `cruce_medias`, divisas en 1h | Pierde con los parámetros por defecto. El aprendizaje adoptó otros (EMA 20/100, stop 3 ATR) que ganaron en validación |

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
| **Simulado** (por defecto) | `crypto.broker: "paper"`, `forex.broker: "paper"` | Ficticio |
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

```bash
npm install -g pm2
pm2 start dist/index.js --name trading-bot -- run
pm2 logs trading-bot
```

## Limitaciones

- El backtest simula comisiones, deslizamiento y spread, pero no la profundidad real del libro de órdenes ni caídas del exchange.
- En pares de poco volumen, el límite de liquidez deja posiciones pequeñas. Esta estrategia no escala a cuentas grandes.
- Los datos de futuros (liquidaciones, financiación y posición de los grandes traders) darían más pistas sobre las cascadas, pero todavía no se usan.
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
| `engine.ts`, `backtest.ts` | Bucle del bot y backtest, con las mismas reglas |
| `risk.ts`, `stops.ts` | Tamaño de posición, límites, stops, objetivo y stop dinámico |
| `brokers/`, `data/` | Simulado, exchanges (ccxt), OANDA; datos de Binance, ccxt, Yahoo y OANDA |

Para añadir una estrategia, crea un archivo en `strategies/` con la interfaz de `strategies/types.ts`: parámetros, rejilla de aprendizaje, `prepare` y `evaluate`. Después regístrala en `strategy.ts`.
