// Live smoke test for market-signals-mcp: calls every tool against the real public endpoints.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke-signals", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/signals/index.js"], env: { ...process.env } }));
const { tools } = await client.listTools();
console.log(`TOOLS (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);

const calls = [
  ["options_get_implied_move", { symbol: "SPY", max_expiries: 3 }],
  ["options_get_implied_move", { symbol: "SPX", max_expiries: 2, levels: [-5, 5] }],
  ["rates_get_fed_probabilities", { meetings: 3 }],
  ["rates_get_treasury_auctions", { limit: 4 }],
  ["calendar_get_economic_events", { time_zone: "America/Mexico_City" }],
  ["positioning_get_cot", { contracts: ["sp500", "mxn", "gold"] }],
  ["sentiment_get_fear_greed", {}],
  ["sentiment_get_prediction_markets", { query: "recession", limit: 3 }],
  ["earnings_get_expectations", { symbol: "MSFT" }],
  ["earnings_get_calendar", { date: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10), min_market_cap_billions: 50 }],
  ["stocks_get_short_interest", { symbol: "AAPL", days: 3 }],
  ["mexico_get_banxico_series", {}],
];

let failed = 0;
for (const [name, args] of calls) {
  const t = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  // Banxico needs a token; without one the tool must explain how to get it.
  const expectedError = name === "mexico_get_banxico_series" && !process.env.BANXICO_TOKEN && text.includes("BANXICO_TOKEN");
  const ok = !res.isError || expectedError;
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name} ${JSON.stringify(args)} (${Date.now() - t} ms)\n${text.slice(0, 300)}\n`);
}
await client.close();
if (failed) {
  console.error(`${failed} call(s) failed`);
  process.exit(1);
}
