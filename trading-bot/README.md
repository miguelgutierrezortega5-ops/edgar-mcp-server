# Bot de trading de criptomonedas y divisas

Bot que vigila mercados de cripto y forex, decide entradas y salidas con una estrategia de seguimiento de tendencia y las ejecuta con gestión del riesgo. Funciona **en modo simulado (paper trading) por defecto**, sin claves ni dinero real.

> ⚠️ **Lee esto antes de usarlo con dinero.** El trading automático puede hacerte perder dinero, y con apalancamiento (forex) más de lo que esperas. Ninguna estrategia gana siempre: la incluida **perdió dinero en el backtest del último año** (ver [Resultados](#resultados-del-backtest)). Es una base sólida para experimentar, no una máquina de hacer dinero ni asesoramiento financiero.

## Qué hace

- **Vigila** cada mercado configurado (velas de 5 min a 1 día): tendencia, cruce de medias, RSI y volatilidad (ATR).
- **Decide** con reglas fijas y transparentes ([estrategia](#cómo-decide)).
- **Limita el riesgo**: arriesga un % fijo del capital por operación, pone stop-loss y objetivo en cada una, y se para solo ante una racha de pérdidas.
- **Ejecuta** en:
  - una cuenta **simulada** con comisiones, deslizamiento y spread realistas (por defecto);
  - un **exchange de cripto** (Binance, Kraken, Coinbase, Bybit, OKX… vía [ccxt](https://github.com/ccxt/ccxt)), en su red de pruebas o con dinero real;
  - **OANDA** para divisas, en cuenta demo o real.
- **Prueba** la estrategia con datos históricos (backtest) con las mismas reglas que usa en vivo.
- **Avisa** por Telegram de cada operación (opcional) y guarda un registro en `data/trades.csv`.

## Instalación

Necesitas [Node.js 20.12 o superior](https://nodejs.org).

```bash
cd trading-bot
npm install                      # descarga dependencias y compila
cp config.example.json config.json
cp .env.example .env             # solo si vas a usar claves o Telegram
```

## Primeros pasos

```bash
npm run scan                     # foto del mercado ahora mismo
npm run backtest                 # cómo le habría ido el último año
npm run bot                      # arranca el bot (Ctrl+C para pararlo)
npm run status                   # saldo, posiciones y últimas operaciones
```

`npm run scan` muestra algo así:

```
Mercado     Precio   24h     Tendencia  Medias         RSI   ATR    Señal
----------  -------  ------  ---------  -------------  ----  -----  ---------------------------------
BTC/USD 1h  84128.4  +1.36%  alcista    EMA20 > EMA50  58.5  0.50%  EMA rápida por encima de la lenta
EUR/USD 1h  1.13186  -0.31%  bajista    EMA20 < EMA50  36.8  0.08%  EMA rápida por debajo de la lenta
USD/JPY 1h  158.124  +0.82%  alcista    EMA20 > EMA50  76.8  0.14%  EMA rápida por encima de la lenta
```

Opciones útiles:

| Comando | Qué hace |
| --- | --- |
| `npm run backtest -- --dias 730` | Backtest de 2 años |
| `npm run backtest -- --mercado BTC/USDT --operaciones` | Un solo mercado, con la lista de operaciones |
| `npm run bot -- --once` | Una sola revisión y termina (para lanzarlo con cron) |
| `npm run status -- --reanudar` | Reactiva el trading tras una parada por pérdidas |
| `node dist/index.js <comando> --config otra.json` | Usa otro archivo de configuración |

## Cómo decide

Estrategia de **cruce de medias con filtro de tendencia**, evaluada al cierre de cada vela:

| | Regla (valores por defecto) |
| --- | --- |
| **Compra** | La media exponencial rápida (EMA 20) cruza por encima de la lenta (EMA 50), el precio está por encima de la EMA 200 (tendencia alcista) y el RSI(14) no está sobrecomprado (< 70) |
| **Venta en corto** | Lo contrario: cruce bajista, precio bajo la EMA 200 y RSI > 30. Solo en divisas (en cripto spot no se puede vender en corto) |
| **Stop-loss** | 2 × ATR(14) desde el precio de entrada |
| **Objetivo** | 4 × ATR(14) (relación beneficio/riesgo 2:1). `takeProfitAtr: 0` lo desactiva |
| **Stop dinámico** | Opcional (`trailingStopAtr`): sigue al precio a N × ATR del máximo alcanzado |
| **Salida** | Al tocar el stop o el objetivo, o con el cruce de medias contrario |

Todos los parámetros se cambian en `config.json`, en general (`strategy`) o por mercado.

## Gestión del riesgo

| Parámetro | Por defecto | Qué hace |
| --- | --- | --- |
| `riskPerTradePct` | 1 | % del capital que se pierde si salta el stop. El tamaño de cada posición se calcula a partir de esto |
| `maxNotionalPct.crypto` | 25 | Valor máximo de una posición de cripto, en % del capital |
| `maxNotionalPct.forex` | 500 | Ídem en divisas (500% = apalancamiento 5:1, por debajo del 30:1 que permite la normativa europea) |
| `maxOpenPositions` | 4 | Posiciones abiertas a la vez |
| `dailyLossLimitPct` | 3 | Si se pierde este % en el día (UTC), no abre más operaciones hasta el día siguiente |
| `maxDrawdownPct` | 15 | Si el capital cae este % desde su máximo, **cierra todo y se detiene** hasta `npm run status -- --reanudar` |

## Modos de operación

| Modo | Configuración | Dinero |
| --- | --- | --- |
| **Simulado** (por defecto) | `crypto.broker: "paper"`, `forex.broker: "paper"` | Ficticio: `paper.startingBalance` |
| **Exchange en red de pruebas** | `crypto.broker: "exchange"`, `sandbox: true` + claves de la testnet | Ficticio (p. ej. [testnet de Binance](https://testnet.binance.vision)) |
| **OANDA demo** | `forex.broker: "oanda"`, `oandaEnv: "practice"` + claves de una cuenta demo | Ficticio |
| **Real** | `sandbox: false` u `oandaEnv: "live"` **y** `CONFIRMAR_DINERO_REAL=si` en `.env` | **Real** |

El bot se niega a arrancar con dinero real si falta `CONFIRMAR_DINERO_REAL=si`. Recomendación: backtest → simulado durante semanas → cuenta de pruebas → real con poco dinero.

Al pasar a un exchange real:

- crea la clave de API **solo con permiso de trading, nunca de retirada**;
- usa una subcuenta dedicada: el bot calcula el capital con todo el saldo de la cuenta;
- **los stops de cripto los vigila el bot**: si el bot está parado, no te protegen. En OANDA el stop y el objetivo se envían con la orden y viven en el servidor del broker.

## Configuración

`config.json` (ver `config.example.json`):

| Clave | Qué es |
| --- | --- |
| `accountCurrency` | Moneda de la cuenta (`USD`). Las stablecoins (USDT, USDC…) cuentan como USD |
| `pollSeconds` | Cada cuántos segundos revisa los mercados (60) |
| `historyBars` | Velas que mantiene en memoria para los indicadores (720) |
| `paper` | Capital inicial simulado, comisión y deslizamiento de cripto (%), spread de divisas (pips) |
| `risk`, `strategy` | Ver tablas anteriores |
| `crypto.exchange` | Exchange de ccxt para precios y órdenes: `binance`, `kraken`, `coinbase`, `bybit`, `okx`… |
| `crypto.markets` | Pares como `BTC/USDT`, con `timeframe` (`5m`, `15m`, `30m`, `1h`, `4h`, `1d`) y, opcionalmente, su propia `strategy` |
| `forex.data` | Precios de `yahoo` (gratis, sin clave, solo uso personal) u `oanda` |
| `forex.markets` | Pares como `EUR/USD`, `USD/JPY`, `EUR/GBP` |
| `telegram.enabled` | Envía avisos si hay `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` en `.env` |

Ejemplo de ajuste por mercado:

```json
{ "symbol": "ETH/USDT", "timeframe": "4h", "strategy": { "stopAtr": 3, "trailingStopAtr": 3, "takeProfitAtr": 0 } }
```

Binance no da servicio desde EE. UU. (devuelve el error 451): allí usa `kraken` o `coinbase`. Kraken solo sirve sus últimas 720 velas, así que sus backtests son cortos. Coinbase no tiene velas de 4h.

El estado (saldo simulado, posiciones, límites) se guarda en `data/state.json`. Para empezar de cero, borra la carpeta `data/`.

## Tenerlo en marcha 24/7

El bot tiene que estar encendido para operar. Algunas opciones en un servidor o una Raspberry Pi:

```bash
# con pm2
npm install -g pm2
pm2 start dist/index.js --name trading-bot -- run
pm2 logs trading-bot

# o con cron, una revisión cada 5 minutos
*/5 * * * * cd /ruta/a/trading-bot && node dist/index.js run --once >> data/bot.log 2>&1
```

## Resultados del backtest

Configuración por defecto, velas de 1 hora, del 1-10-2025 al 1-10-2026, 10.000 USD por mercado. Cripto con datos de Coinbase y divisas con Yahoo Finance:

| Mercado | Operaciones | Aciertos | Resultado | Comprar y mantener | Máx. caída |
| --- | --- | --- | --- | --- | --- |
| BTC/USD | 32 | 41% | -1,4% | -26,3% | -3,0% |
| ETH/USD | 40 | 38% | -3,6% | -34,2% | -3,9% |
| EUR/USD | 52 | 25% | -9,7% (se detuvo por drawdown) | -3,9% | -15,1% |
| GBP/USD | 67 | 34% | -0,7% | -1,7% | -10,5% |
| USD/JPY | 60 | 30% | -4,1% | +7,6% | -9,6% |

Lectura honesta: en cripto la gestión del riesgo funcionó (perdió poco mientras el mercado caía un 26-34%), pero **la estrategia no ganó dinero en ningún mercado** ese año. En velas de 4 horas desde noviembre de 2024, EUR/USD ganó un 4,6% y GBP/USD y USD/JPY perdieron. Antes de arriesgar dinero, prueba otros parámetros y periodos, desconfía de los que solo funcionan en un tramo concreto de la historia y compáralos siempre con comprar y mantener.

## Limitaciones

- El backtest simula comisiones, deslizamiento y spread, pero no huecos de liquidez, caídas del exchange ni el coste de mantener posiciones de divisas de un día a otro (swap).
- En modo simulado, los stops se comprueban con las velas y el último precio en cada revisión: un pico muy breve entre dos revisiones dentro de la vela de entrada puede pasar desapercibido.
- Si una vela toca el stop y el objetivo a la vez, se asume el stop (lo prudente).
- Yahoo Finance es un servicio no oficial: puede fallar o cambiar sin aviso, y sus condiciones no permiten el uso comercial.
- Las conversiones de divisas cruzadas (p. ej. EUR/GBP a USD) usan el tipo de cambio de Yahoo.

## Desarrollo

```bash
npm test          # compila y ejecuta las pruebas, sin conexión
```

Código en `src/`:

| Archivo | Qué contiene |
| --- | --- |
| `strategy.ts`, `indicators.ts` | Estrategia e indicadores (EMA, RSI y ATR de Wilder) |
| `risk.ts`, `stops.ts` | Tamaño de posición, límites, stop-loss, objetivo y stop dinámico |
| `engine.ts` | Bucle del bot: datos → señales → órdenes |
| `backtest.ts` | Backtest con las mismas reglas |
| `brokers/` | Simulado (`paper.ts`), exchanges de cripto (`exchange.ts`) y OANDA (`oanda.ts`) |
| `data/` | Velas de ccxt, Yahoo Finance y OANDA |

Para probar otra estrategia, modifica `evaluate` en `strategy.ts`: recibe los indicadores de una vela y devuelve si hay que entrar, salir o esperar, y la usan tanto el bot como el backtest.
