# edgar-mcp-server

[![CI](https://github.com/miguelgutierrezortega5-ops/edgar-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/miguelgutierrezortega5-ops/edgar-mcp-server/actions/workflows/ci.yml)
[![Licencia: MIT](https://img.shields.io/badge/licencia-MIT-blue.svg)](LICENSE)

Servidor MCP que da a Claude acceso a datos financieros **gratuitos y oficiales**, sin suscripciones:

| Fuente | Qué aporta |
| --- | --- |
| **SEC EDGAR** | Estados financieros XBRL, métricas clave, filings (10-K, 10-Q, 8-K, proxies…), búsqueda de texto completo, operaciones de insiders (Form 4), carteras de fondos (13F) y rankings de todas las empresas |
| **Tesoro de EE. UU.** | Curva de tipos oficial (tasa libre de riesgo) |
| **FRED** (Reserva Federal de St. Louis) | Más de 800.000 series: tipos, inflación, empleo, PIB, masa monetaria, diferenciales de crédito, divisas, materias primas, recesión |
| **Banco Mundial** | Indicadores anuales de cualquier país: PIB, inflación, paro, deuda… |
| **Yahoo Finance** (no oficial) | Precios, dividendos, splits, divisas e índices |

Cubre las empresas que presentan informes ante la SEC: unas 10.000 cotizadas en EE. UU. y emisores extranjeros con 20-F o 40-F (TSM, ASML, Toyota…).

> ⚠️ Herramienta de información y análisis, no de asesoramiento financiero.

## Instalación

Solo necesitas decirle a la SEC quién eres: **tu nombre y tu email** (p. ej. `Juan Pérez juan@correo.com`). No hay registro ni claves.

### Opción A — Claude Desktop con un clic (recomendada)

1. Descarga `edgar-mcp-server-<versión>.mcpb` desde [Releases](https://github.com/miguelgutierrezortega5-ops/edgar-mcp-server/releases).
2. Ábrelo con doble clic, o arrástralo a Claude Desktop → **Configuración → Extensiones**.
3. Pulsa **Instalar** y escribe tu nombre y email cuando te lo pida.

No hace falta instalar Node.js: Claude Desktop trae su propio entorno.

### Opción B — Instalador automático (Claude Desktop y Claude Code)

Necesitas [Node.js 18+](https://nodejs.org) y [Git](https://git-scm.com/downloads).

```bash
git clone https://github.com/miguelgutierrezortega5-ops/edgar-mcp-server.git
cd edgar-mcp-server
npm install        # descarga dependencias y compila
npm run setup      # pregunta tu nombre y email y configura Claude Desktop y/o Claude Code
```

El instalador:

- añade el servidor a `claude_desktop_config.json` y guarda una copia de seguridad (`.bak`);
- lo registra en Claude Code para todos tus proyectos;
- instala la skill de análisis en `~/.claude/skills`.

Después, **reinicia Claude Desktop**.

Sin preguntas: `npm run setup -- --user-agent "Tu Nombre tu@email.com" --yes`

### Opción C — Manual

**Claude Code**

```bash
npm install
claude mcp add edgar --scope user -e SEC_USER_AGENT="Tu Nombre tu@email.com" -- node "$(pwd)/dist/index.js"
mkdir -p ~/.claude/skills && cp -r skills/sec-financial-analysis ~/.claude/skills/
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "edgar": {
      "command": "node",
      "args": ["/ruta/a/edgar-mcp-server/dist/index.js"],
      "env": { "SEC_USER_AGENT": "Tu Nombre tu@email.com" }
    }
  }
}
```

### Skill de análisis en claude.ai o Claude Desktop

La skill `sec-financial-analysis` enseña a Claude flujos de análisis completos (empresa, comparación, DCF, resultados, insiders, 13F, dividendos, macro). Para usarla en claude.ai o Claude Desktop:

1. Descarga `sec-financial-analysis-skill.zip` desde [Releases](https://github.com/miguelgutierrezortega5-ops/edgar-mcp-server/releases).
2. Súbela en **Configuración → Capacidades → Skills**.

## Primeros pasos

Escribe en Claude, por ejemplo:

- «Analiza Microsoft: márgenes, flujo de caja y valoración»
- «Compara Coca-Cola, Pepsi y Monster»
- «¿Qué ha comprado y vendido Berkshire Hathaway este trimestre?»
- «¿Los directivos de Nvidia están vendiendo acciones?»
- «Historial de dividendos de Johnson & Johnson y si es sostenible»
- «¿Cómo están la inflación y los tipos en EE. UU.? Compáralo con México»
- «Busca empresas que mencionen "aranceles" en su último 10-K»

O usa las **plantillas** del menú **+ → edgar** en Claude Desktop:

| Plantilla | Qué hace |
| --- | --- |
| `analizar_empresa` | Análisis fundamental completo: negocio, resultados, balance, flujo de caja, valoración, insiders y riesgos |
| `comparar_empresas` | Compara 2-10 empresas en crecimiento, rentabilidad, solidez y valoración |
| `valoracion_dcf` | Valor intrínseco por DCF con escenarios y tabla de sensibilidad |
| `resultados_trimestrales` | Resume el último informe trimestral y el comunicado de resultados |
| `cartera_inversor` | Cartera 13F de un fondo o inversor y sus movimientos del trimestre |
| `panorama_macro` | Tipos, inflación, empleo, crecimiento y riesgo de recesión |

## Herramientas (20)

| Herramienta | Qué hace |
| --- | --- |
| `edgar_search_companies` | Busca empresas por ticker o nombre |
| `edgar_get_company_info` | Perfil SEC: sector (SIC), cierre fiscal, sede, últimos informes |
| `edgar_list_filings` | Lista filings por tipo y fecha (10-K, 10-Q, 8-K, DEF 14A, 4, S-1…) |
| `edgar_read_filing` | Lee un filing o sus anexos. Salta a secciones del 10-K (`business`, `risk_factors`, `mdna`…) o a una frase |
| `edgar_full_text_search` | Búsqueda de texto completo en todos los filings desde 2001 |
| `edgar_get_financial_statement` | Cuenta de resultados, balance o flujo de caja, anual o trimestral, con FCF |
| `edgar_get_key_metrics` | Crecimiento, márgenes, EPS, FCF, ROE, ROA, liquidez, deuda, caja neta, recompras |
| `edgar_compare_companies` | Compara de 2 a 10 empresas en métricas clave |
| `edgar_search_concepts` | Encuentra cualquier dato XBRL que reporte una empresa (backlog, leasing…) |
| `edgar_get_concept` | Histórico de un dato XBRL concreto |
| `edgar_rank_companies` | Ranking de todas las empresas en un dato para un periodo |
| `edgar_get_insider_trades` | Compras y ventas de directivos (Form 4), con planes 10b5-1 |
| `edgar_get_institutional_holdings` | Cartera 13F de un fondo o inversor, con cambios frente al trimestre anterior |
| `market_get_stock_price` | Precio, rango de 52 semanas, rentabilidad, drawdown e histórico. También índices (`^GSPC`) y divisas (`EURUSD=X`) |
| `market_get_dividends` | Dividendos y splits: rentabilidad TTM, crecimiento a 5 y 10 años, años seguidos de subidas |
| `market_get_treasury_yields` | Curva de tipos del Tesoro de EE. UU. |
| `market_get_valuation` | P/E, P/S, P/FCF, EV/Revenue, EV/EBIT y rentabilidades con fundamentales TTM |
| `macro_get_series` | Series económicas de FRED, hasta 5 a la vez, con variaciones interanuales y cambio de frecuencia |
| `macro_search_series` | Busca series de FRED por palabra clave |
| `macro_get_country_indicator` | Indicadores anuales por país del Banco Mundial |

## Configuración

| Variable | Obligatoria | Para qué |
| --- | --- | --- |
| `SEC_USER_AGENT` | Sí | Tu nombre y email, exigidos por la SEC |
| `FRED_API_KEY` | No | Busca entre todas las series de FRED (gratis, ver abajo). Sin ella, `macro_search_series` usa un catálogo de ~50 series clave; los datos se descargan igual |
| `EDGAR_CACHE_MAX_MB` | No | Tamaño de la caché en memoria (por defecto 100; los datos XBRL de una empresa grande ocupan 5-8 MB) |

### Modo HTTP

Para exponer el servidor a otros clientes por HTTP en lugar de stdio:

```bash
TRANSPORT=http PORT=3000 SEC_USER_AGENT="Tu Nombre tu@email.com" npm start   # POST http://127.0.0.1:3000/mcp
```

Por defecto escucha solo en `127.0.0.1` y rechaza peticiones con otra cabecera `Host` (protección contra *DNS rebinding*). Para exponerlo en la red:

| Variable | Para qué |
| --- | --- |
| `HOST` | Interfaz de escucha, p. ej. `0.0.0.0` |
| `MCP_AUTH_TOKEN` | Exige `Authorization: Bearer <token>` en cada petición. **Recomendado** fuera de localhost |
| `ALLOWED_HOSTS` | Nombres de host aceptados, separados por comas, p. ej. `mcp.midominio.com` |

## Cómo funcionan los datos

- Los estados financieros salen de los datos XBRL de la SEC. Para cada periodo manda el último filing, así que las reexpresiones quedan reflejadas.
- Los trimestres que las empresas solo publican como acumulado del año (flujos de caja y cuarto trimestre fiscal) se calculan por diferencia. La tabla indica cuándo pasa.
- Las columnas son fechas de cierre de periodo. Cada empresa tiene su propio año fiscal.
- Las empresas extranjeras se muestran en su moneda (TWD, EUR…), no en las traducciones a USD que publican solo para algunos años.
- El EPS y el número de acciones son los reportados en su momento, y pueden no estar ajustados por splits posteriores.
- El conjunto XBRL de la SEC puede ir unos días o semanas por detrás de los filings. `market_get_valuation` avisa cuando es así.
- `market_get_valuation` usa los últimos 4 trimestres consecutivos (TTM) o, si falta alguno, el último año fiscal. No calcula múltiplos cuando los datos están en otra moneda que el precio (ADRs como TSM o NVO) ni cuando no hay un número de acciones actual (p. ej. Berkshire). En esos casos devuelve un error explicado en lugar de cifras engañosas.
- Los 13F llegan hasta 45 días después del cierre del trimestre y solo incluyen posiciones largas en valores cotizados en EE. UU.
- Para respetar la política de la SEC, el servidor limita las peticiones a 8 por segundo, reintenta ante errores 429 y 5xx, y guarda en caché las respuestas.

## Licencias y fuentes de datos

**El código** se publica con licencia [MIT](LICENSE): cualquiera puede usarlo, modificarlo y venderlo, siempre que conserve el aviso de copyright. Todas las dependencias del servidor tienen licencias permisivas compatibles (MIT, ISC y BSD).

**Los datos** no necesitan licencia para uso personal, pero cada fuente tiene sus condiciones:

| Fuente | Condiciones | ¿Clave? | Uso comercial |
| --- | --- | --- | --- |
| SEC EDGAR | Datos públicos y gratuitos del Gobierno de EE. UU. Hay que identificarse (`SEC_USER_AGENT`) y no superar 10 peticiones por segundo ([normas](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data)) | No | Sí |
| Tesoro de EE. UU. | Dominio público | No | Sí |
| FRED | [Términos de uso](https://fred.stlouisfed.org/docs/api/terms_of_use.html). La mayoría de series son públicas; algunas tienen copyright de terceros (S&P 500, VIX, diferenciales de ICE, Case-Shiller, U. Michigan, Freddie Mac) y solo permiten uso personal. La herramienta avisa de ellas | Opcional (búsqueda) | Solo series sin copyright de terceros |
| Banco Mundial | [CC BY 4.0](https://datacatalog.worldbank.org/public-licenses): libre citando la fuente | No | Sí, citando |
| Yahoo Finance | Endpoint **no oficial** sin licencia. Sus condiciones no permiten redistribuir los datos ni el uso comercial | No | **No** |

Para un uso **comercial** de precios y dividendos, sustituye Yahoo por un proveedor con licencia (Polygon.io, Tiingo, Twelve Data, Financial Modeling Prep…; casi todos tienen un plan gratuito con clave).

This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.

### Clave gratuita de FRED (opcional)

Solo sirve para que `macro_search_series` busque entre las 800.000 series de FRED; el resto funciona sin ella.

1. Crea una cuenta en [fredaccount.stlouisfed.org](https://fredaccount.stlouisfed.org/login/secure/).
2. Ve a **API Keys → Request API Key**, describe el uso (p. ej. «uso personal con un asistente de IA») y acepta los términos.
3. Copia la clave de 32 caracteres en el campo *Clave de API de FRED* de la extensión, o pásala con `npm run setup -- --fred-key TU_CLAVE`.

## Desarrollo

```bash
npm install          # instala y compila
npm test             # pruebas unitarias, sin conexión (las mismas que ejecuta la CI)
npm run test:live    # prueba las 20 herramientas contra las fuentes reales (requiere internet)
npm run bundle       # genera build/edgar-mcp-server-<versión>.mcpb y el zip de la skill
```

Publicar una versión: sube la versión en `package.json`, `manifest.json` y `src/constants.ts`; después crea y sube la etiqueta (`git tag v1.2.0 && git push origin v1.2.0`). GitHub Actions genera la extensión y el zip de la skill y los adjunta a una Release.
