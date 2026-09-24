// Live smoke test: calls every tool against the real SEC, Treasury, Yahoo, FRED and World Bank endpoints.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "0" });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, SEC_USER_AGENT: process.env.SEC_USER_AGENT ?? "edgar-mcp-server smoke-test test@example.com" },
  }),
);
const { tools } = await client.listTools();
console.log(`TOOLS (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);

const calls = [
  ["edgar_search_companies", { query: "coca" }],
  ["edgar_get_company_info", { company: "AAPL" }],
  ["edgar_list_filings", { company: "MSFT", forms: ["10-K", "8-K"], limit: 5 }],
  ["edgar_read_filing", { company: "MSFT", section: "risk_factors", max_chars: 1500 }],
  ["edgar_read_filing", { company: "NVDA", find: "export controls", max_chars: 1000 }],
  ["edgar_read_filing", { company: "MSFT", accession_number: "0001193125-26-323632", document: "msft-ex99_1.htm", find: "revenue was", max_chars: 1000 }],
  ["edgar_full_text_search", { query: '"tariffs" "supply chain"', forms: ["10-K"], start_date: "2026-01-01", limit: 5 }],
  ["edgar_get_financial_statement", { company: "KO", statement: "income", max_periods: 4 }],
  ["edgar_get_financial_statement", { company: "AAPL", statement: "cashflow", period: "quarterly", max_periods: 4 }],
  ["edgar_get_key_metrics", { company: "NVDA", max_periods: 4 }],
  ["edgar_compare_companies", { companies: ["KO", "PEP", "MNST"], metrics: ["revenue", "revenue_growth", "operating_margin", "roe"] }],
  ["edgar_search_concepts", { company: "MSFT", query: "remaining performance", limit: 5 }],
  ["edgar_get_concept", { company: "MSFT", concept: "RevenueRemainingPerformanceObligation", period: "all", max_points: 4 }],
  ["edgar_rank_companies", { concept: "us-gaap:NetIncomeLoss", period: "CY2025", limit: 5, highlight: "KO" }],
  ["edgar_get_insider_trades", { company: "NVDA", max_filings: 10 }],
  ["market_get_stock_price", { symbol: "KO", range: "1y", max_points: 5 }],
  ["market_get_treasury_yields", {}],
  ["market_get_valuation", { company: "KO" }],
  ["market_get_dividends", { symbol: "KO", years: 5 }],
  ["edgar_get_institutional_holdings", { manager: "Berkshire Hathaway", limit: 5 }],
  ["macro_get_series", { series_ids: ["DGS10", "DGS2"], start_date: "2025-01-01", frequency: "monthly", max_points: 6 }],
  ["macro_search_series", { query: "unemployment" }],
  ["macro_get_country_indicator", { countries: ["MX", "US"], indicator: "gdp_growth", start_year: 2020 }],
  // error paths
  ["edgar_get_company_info", { company: "zzzz-not-a-company" }],
  ["edgar_get_concept", { company: "MSFT", concept: "NotARealConcept" }],
  ["market_get_stock_price", { symbol: "NOTATICKERXYZ" }],
  ["market_get_valuation", { company: "TSM" }], // ADR reporting in TWD: refuses rather than mix currencies
];
const covered = new Set();
let failures = 0;
for (const [name, args] of calls) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  covered.add(name);
  const text = r.content.map((c) => c.text).join("\n");
  const expectError =
    (name.includes("info") && args.company.startsWith("zzzz")) || args.concept === "NotARealConcept" || args.symbol === "NOTATICKERXYZ" || (name === "market_get_valuation" && args.company === "TSM");
  if (Boolean(r.isError) !== expectError) failures++;
  console.log(`\n===== ${name} ${JSON.stringify(args)} ${r.isError ? "[isError]" : ""} (${Date.now() - t0} ms)\n${text.slice(0, 1400)}${text.length > 1400 ? `\n…(${text.length} chars)` : ""}`);
}
const uncovered = tools.map((t) => t.name).filter((n) => !covered.has(n));
console.log(`\nUNCOVERED: ${JSON.stringify(uncovered)}  UNEXPECTED RESULTS: ${failures}`);
await client.close();
process.exit(failures || uncovered.length ? 1 : 0);
