# edgar-mcp-server

Servidor MCP con datos financieros **gratuitos y públicos**, sin API keys ni suscripciones:

- **SEC EDGAR** (fuente oficial de EE. UU.): estados financieros XBRL, métricas clave, filings (10-K, 10-Q, 8-K, proxies…), búsqueda de texto completo, operaciones de insiders (Form 4) y rankings de todas las empresas.
- **U.S. Treasury**: curva de tipos oficial, para la tasa libre de riesgo.
- **Yahoo Finance**, endpoint público no oficial: precios y múltiplos de valoración.

Cubre las empresas que presentan informes ante la SEC: unas 10.000 cotizadas en EE. UU. y emisores extranjeros con 20-F o 40-F (TSM, ASML, Toyota…).

Incluye la skill **`sec-financial-analysis`**, con flujos de trabajo de análisis (empresa, comparación, DCF, resultados, insiders…) que usan estas herramientas.

## Requisitos

- Node.js 18 o superior
- `SEC_USER_AGENT`: la SEC exige identificarse con un nombre y un email, por ejemplo `"Juan Pérez juan@correo.com"`. No hace falta registrarse.

## Instalación

```bash
npm install
npm run build
```

### Claude Code

```bash
claude mcp add edgar -e SEC_USER_AGENT="Tu Nombre tu@email.com" -- node "$(pwd)/dist/index.js"

# Skill de análisis (opcional, recomendado)
mkdir -p ~/.claude/skills && cp -r skills/sec-financial-analysis ~/.claude/skills/
```

### Claude Desktop (`claude_desktop_config.json`)

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

### Modo HTTP

```bash
TRANSPORT=http PORT=3000 SEC_USER_AGENT="Tu Nombre tu@email.com" npm start   # POST http://127.0.0.1:3000/mcp
```

## Herramientas (15)

| Herramienta | Qué hace |
| --- | --- |
| `edgar_search_companies` | Busca empresas por ticker o nombre |
| `edgar_get_company_info` | Perfil SEC: sector (SIC), cierre fiscal, sede, últimos informes |
| `edgar_list_filings` | Lista filings por tipo y fecha (10-K, 10-Q, 8-K, DEF 14A, 4, S-1…) |
| `edgar_read_filing` | Lee un filing o sus anexos (p. ej. el comunicado de resultados de un 8-K). Salta a secciones del 10-K (`business`, `risk_factors`, `mdna`…) o a una frase |
| `edgar_full_text_search` | Búsqueda de texto completo en todos los filings desde 2001 |
| `edgar_get_financial_statement` | Income statement, balance sheet o cash flow, anual o trimestral, con FCF |
| `edgar_get_key_metrics` | Crecimiento, márgenes, EPS, FCF, ROE, ROA, liquidez, deuda, caja neta, recompras |
| `edgar_compare_companies` | Compara de 2 a 10 empresas en métricas clave |
| `edgar_search_concepts` | Encuentra cualquier dato XBRL que reporte una empresa (backlog, leasing…) |
| `edgar_get_concept` | Histórico de un dato XBRL concreto |
| `edgar_rank_companies` | Ranking de todas las empresas en un dato para un periodo (p. ej. beneficio neto de 2025) |
| `edgar_get_insider_trades` | Compras y ventas de directivos (Form 4), con resumen de compras y ventas en mercado abierto |
| `market_get_stock_price` | Precio actual, rango de 52 semanas, rentabilidad, drawdown e histórico |
| `market_get_treasury_yields` | Curva de tipos del Tesoro de EE. UU. |
| `market_get_valuation` | P/E, P/S, P/FCF, EV/Revenue, EV/EBIT y rentabilidades, con fundamentales de los últimos 12 meses (TTM) |

## Cómo funcionan los datos

- Los estados financieros salen de los datos XBRL de la SEC. Para cada periodo manda el último filing, así que las reexpresiones quedan reflejadas.
- Los trimestres que las empresas solo publican como acumulado del año (flujos de caja y cuarto trimestre fiscal) se calculan por diferencia. La tabla indica cuándo pasa.
- Las columnas son fechas de cierre de periodo. Cada empresa tiene su propio año fiscal.
- El EPS y el número de acciones son los reportados en su momento, y pueden no estar ajustados por splits posteriores.
- El conjunto XBRL de la SEC puede ir unos días o semanas por detrás de los filings. `market_get_valuation` avisa cuando es así.
- Para respetar la política de la SEC, el servidor limita las peticiones a 8 por segundo, reintenta ante errores 429 y 5xx, y guarda en caché las respuestas grandes.
- Los precios salen de un endpoint no oficial de Yahoo Finance, que podría dejar de funcionar. Todo lo demás son fuentes oficiales.

## Pruebas

```bash
npm test   # ejecuta las 15 herramientas contra la SEC, el Tesoro y Yahoo reales (requiere internet)
```
