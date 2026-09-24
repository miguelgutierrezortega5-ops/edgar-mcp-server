# Cambios

## Sin publicar

### Corregido

- `edgar_get_insider_trades` ya no mezcla las operaciones que la empresa hace como inversora en otras compañías (p. ej. los fondos GV de Alphabet) con las de sus propios directivos.
- `market_get_stock_price` muestra "–" en lugar de 0 cuando Yahoo no da el rango de 52 semanas.

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
