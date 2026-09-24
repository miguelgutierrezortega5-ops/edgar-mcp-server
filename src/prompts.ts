/**
 * Ready-made analysis workflows, offered by MCP clients as prompts (e.g. the "+" menu in
 * Claude Desktop). They are written in Spanish, the language of this project's users; Claude
 * answers in the language of the conversation.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const RULES = `Reglas:
- Cita la fuente y el periodo de cada cifra (p. ej. "10-K FY2025", "TTM a 2026-06-30").
- Si una herramienta muestra un aviso ⚠️ (datos desfasados, varias clases de acciones, emisor extranjero) o se niega a calcular algo, dilo y explica la alternativa.
- Distingue hechos de opiniones y no des recomendaciones de compra o venta; señala riesgos y supuestos.`;

const message = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "analizar_empresa",
    {
      title: "Analizar una empresa",
      description: "Análisis fundamental completo: negocio, resultados, balance, flujo de caja, valoración, insiders y riesgos.",
      argsSchema: { empresa: z.string().describe("Ticker, nombre o CIK, p. ej. 'MSFT'") },
    },
    ({ empresa }) =>
      message(`Haz un análisis fundamental de ${empresa} con las herramientas del servidor edgar:
1. edgar_get_company_info: perfil, sector y últimos informes.
2. edgar_read_filing con section='business' (y 'risk_factors'): modelo de negocio y 3-5 riesgos principales, en pocas líneas.
3. edgar_get_key_metrics (anual, 5 periodos) y edgar_get_key_metrics (trimestral, 4 periodos): crecimiento, márgenes, FCF, ROE, deuda.
4. edgar_get_financial_statement statement='cashflow': calidad del beneficio (FCF frente a beneficio neto, SBC, recompras).
5. market_get_valuation y market_get_stock_price (1y): múltiplos y comportamiento de la acción.
6. edgar_get_insider_trades con open_market_only=true: compras o ventas relevantes de directivos.
Termina con un resumen de fortalezas, debilidades, qué vigilar en los próximos resultados y una tabla con las cifras clave.

${RULES}`),
  );

  server.registerPrompt(
    "comparar_empresas",
    {
      title: "Comparar empresas",
      description: "Compara 2-10 empresas en crecimiento, rentabilidad, solidez financiera y valoración.",
      argsSchema: { empresas: z.string().describe("Tickers separados por comas, p. ej. 'KO, PEP, MNST'") },
    },
    ({ empresas }) =>
      message(`Compara estas empresas: ${empresas}.
1. edgar_compare_companies con todas ellas (último año fiscal).
2. market_get_valuation para cada una.
3. Si alguna destaca, edgar_get_key_metrics anual de 5 años para ver la tendencia.
Presenta una tabla comparativa (crecimiento, márgenes, ROE, FCF, deuda, P/E, EV/EBIT, rentabilidad por FCF) y explica qué empresa es más sólida, cuál crece más y cuál parece más barata, y por qué. Ten en cuenta que los ejercicios fiscales pueden cerrar en fechas distintas.

${RULES}`),
  );

  server.registerPrompt(
    "valoracion_dcf",
    {
      title: "Valoración por DCF",
      description: "Valor intrínseco por descuento de flujos de caja, con escenarios y sensibilidad.",
      argsSchema: {
        empresa: z.string().describe("Ticker, nombre o CIK"),
        crecimiento: z.string().optional().describe("Crecimiento anual del FCF que quieres suponer, p. ej. '8%'. Si no lo das, se estima."),
      },
    },
    ({ empresa, crecimiento }) =>
      message(`Estima el valor intrínseco de ${empresa} con un DCF de 10 años:
1. edgar_get_key_metrics (anual, 10 periodos): historial de FCF, SBC y crecimiento.
2. market_get_valuation: precio, acciones, caja y deuda.
3. market_get_treasury_yields: el tipo a 10 años como tasa libre de riesgo.
Supuestos: ${crecimiento ? `crecimiento del FCF del ${crecimiento} en los años 1-5` : "estima el crecimiento a partir del histórico y del sector, y justifícalo"}, desaceleración lineal en los años 6-10, crecimiento terminal del 2,5-3%, tasa de descuento = libre de riesgo + 5% de prima (ajústala si el riesgo lo justifica). Considera restar la SBC al FCF.
Muestra la tabla de flujos, el valor por acción, el margen de seguridad frente al precio actual, y una tabla de sensibilidad (tasa de descuento × crecimiento). Añade escenarios pesimista, base y optimista.

${RULES}`),
  );

  server.registerPrompt(
    "resultados_trimestrales",
    {
      title: "Revisar últimos resultados",
      description: "Resume el último informe trimestral: cifras, comparación interanual y comentarios de la dirección.",
      argsSchema: { empresa: z.string().describe("Ticker, nombre o CIK") },
    },
    ({ empresa }) =>
      message(`Revisa los últimos resultados de ${empresa}:
1. edgar_list_filings con forms ['8-K'] para localizar el comunicado de resultados (item 2.02) y edgar_read_filing con su anexo ex99 (usa 'find' para ir a las cifras).
2. edgar_get_financial_statement statement='income' period='quarterly' (5 periodos) para la comparación interanual.
3. edgar_read_filing del último 10-Q con section='mdna' si hace falta contexto.
Resume ingresos, márgenes, BPA, flujo de caja y previsiones (guidance), qué mejoró o empeoró frente al año anterior y qué destacó la dirección.

${RULES}`),
  );

  server.registerPrompt(
    "cartera_inversor",
    {
      title: "Cartera de un gran inversor (13F)",
      description: "Qué tiene y qué ha comprado o vendido un fondo o inversor institucional en el último trimestre.",
      argsSchema: { gestor: z.string().describe("Nombre o CIK, p. ej. 'Berkshire Hathaway', 'Pershing Square Capital Management'") },
    },
    ({ gestor }) =>
      message(`Analiza la cartera 13F de ${gestor}:
1. edgar_get_institutional_holdings (último trimestre, 25 posiciones).
2. Para las 3-5 mayores compras o posiciones nuevas, edgar_search_companies para el ticker y edgar_get_key_metrics para entender la tesis.
Explica la concentración de la cartera, los movimientos más relevantes (nuevas, aumentadas, reducidas, vendidas) y qué pueden indicar. Recuerda que el 13F llega hasta 45 días tarde y solo muestra posiciones largas en valores de EE. UU.

${RULES}`),
  );

  server.registerPrompt(
    "panorama_macro",
    {
      title: "Panorama macroeconómico",
      description: "Tipos de interés, inflación, empleo, crecimiento y riesgo de recesión, con datos oficiales.",
      argsSchema: { pais: z.string().optional().describe("País para comparar con EE. UU., p. ej. 'Mexico' o 'Spain' (opcional)") },
    },
    ({ pais }) =>
      message(`Dame un panorama macroeconómico actual de EE. UU.${pais ? ` y compáralo con ${pais}` : ""}:
1. macro_get_series con ['FEDFUNDS','DGS2','DGS10'] (5 años, frecuencia mensual) y ['T10Y2Y'] para la curva de tipos.
2. macro_get_series con ['CPIAUCSL','PCEPILFE'] y transform='pct_change_yoy' para la inflación.
3. macro_get_series con ['UNRATE','PAYEMS'] y ['A191RL1Q225SBEA'] para empleo y crecimiento; ['BAMLH0A0HYM2','VIXCLS'] para el riesgo de mercado; ['SAHMREALTIME'] para la señal de recesión.
${pais ? `4. macro_get_country_indicator para ['US','${pais}'] con gdp_growth, inflation y unemployment.\n` : ""}Resume la fase del ciclo, la política de la Reserva Federal, los riesgos principales y qué implica para las acciones y los bonos.

${RULES}`),
  );
}
