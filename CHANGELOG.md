# Cambios

## Sin publicar

### Nuevo

- **Bot de trading de cripto y divisas** (`trading-bot/`): vigila los mercados, opera con una estrategia de cruce de medias con filtros de tendencia y RSI, gestiona el riesgo (riesgo fijo por operación, límite de pérdida diaria y parada por drawdown) y funciona en simulado, en exchanges de cripto vía ccxt o en OANDA. Incluye backtest y avisos por Telegram.
- **Huellas de ballenas y aprendizaje** en el bot: estrategia de capitulación para cripto de bajo volumen (velas de 3m, filtro de cascada de BTC, límite de tamaño por liquidez, salida por tiempo), estudio de patrones (`npm run estudiar`), reajuste automático con validación en datos no vistos y pausa de los mercados sin ventaja (`npm run aprender`, cada 24 h en el bot), datos de Binance con volumen de compras agresivas, y velas de 1m y 3m.
- **Lo mejor de otros bots** en el bot de trading: backtest de cartera con una cuenta compartida, protecciones (enfriamiento y pausa tras una racha de stop-loss), lista dinámica de pares de Binance por volumen, spread y antigüedad, detección de sesgo de anticipación (`npm run verificar`), control por Telegram (`/estado`, `/pausa`, `/reanudar`, `/cerrar`), cuentas simuladas separadas para cripto y divisas, y Dockerfile.
- **Algoritmos cuantitativos y capa adaptativa** en el bot: VPIN, lambda de Kyle, Amihud y exponente de Hurst (medidos en `estudiar` y mostrados en `scan`); evidencia con memoria que se desvanece por estrategia y contexto, que ajusta el tamaño con Kelly y apaga lo que deja de funcionar; ratio de Sharpe deflactado en el aprendizaje para no confundir suerte con ventaja.
- **Datos de futuros de Binance** en el bot: interés abierto, largos/cortos de grandes traders y de todas las cuentas, flujo agresivo y financiación, del archivo público (historia) y de la API (horas recientes, si el país lo permite). Se muestran en `scan`, se miden en `estudiar` y entran en la evidencia de la capa adaptativa.
- **Reto de 50 USD** (`config.reto50.json`): la simulación respeta la orden mínima de 5 USD de Binance y no gasta más efectivo del disponible. Medido antes de arrancar: más riesgo empeora el resultado y llegar a 250 USD en un año tuvo 0% de probabilidad en todos los niveles.

## 1.1.0

### Nuevo

- **Carteras de fondos (13F)**: `edgar_get_institutional_holdings` muestra lo que tiene un fondo o inversor (Berkshire, Pershing Square, Bridgewater…) y lo que compró o vendió frente al trimestre anterior.
- **Dividendos**: `market_get_dividends` calcula la rentabilidad TTM, el crecimiento a 5 y 10 años, los años seguidos de subidas y los splits.
- **Macro**:
  - `macro_get_series` descarga series de FRED (tipos, inflación, empleo, PIB, crédito, divisas…) con variaciones interanuales y cambio de frecuencia.
  - `macro_search_series` busca series de FRED.
  - `macro_get_country_indicator` trae indicadores del Banco Mundial por país.
- **Plantillas en español** (prompts MCP): analizar empresa, comparar empresas, DCF, resultados trimestrales, cartera de un inversor y panorama macro.
- **Instalación**:
  - extensión de Claude Desktop con un clic (`.mcpb`);
  - instalador automático (`npm run setup`) para Claude Desktop y Claude Code;
  - Release automática al subir una etiqueta.
- `market_get_stock_price` acepta índices (`^GSPC`) y divisas (`EURUSD=X`).
- Licencia MIT y documentación de las condiciones de cada fuente de datos. La herramienta avisa de las series de FRED con copyright de terceros.

### Corregido

- Los estados financieros de empresas extranjeras mezclaban monedas (USD de cortesía en unas partidas y moneda local en otras). Ahora cada estado va entero en la moneda de la empresa.
- `market_get_valuation`:
  - rechaza el cálculo si mezclaría monedas (ADRs como TSM o NVO) o si no hay un número de acciones actual (Berkshire);
  - el TTM exige trimestres consecutivos;
  - avisa de varias clases de acciones y de emisores extranjeros.
- `market_get_treasury_yields` ya no falla a principios de enero.
- Form 4: la marca 10b5-1 usa la casilla oficial y las notas de cada operación. Muestra todos los titulares e informa de las descargas fallidas.
- `edgar_rank_companies` valida el concepto y la unidad.

### Mejorado

- Modo HTTP: protección contra *DNS rebinding*, token opcional (`MCP_AUTH_TOKEN`), `ALLOWED_HOSTS` y 405 para GET/DELETE.
- Caché limitada por tamaño, peticiones simultáneas deduplicadas, reintentos que respetan `Retry-After`. Las series XBRL y el texto de los filings quedan en memoria.
- Pruebas unitarias sin conexión e integración continua en GitHub Actions.

## 1.0.0

Primera versión: 15 herramientas sobre SEC EDGAR, el Tesoro de EE. UU. y Yahoo Finance.
