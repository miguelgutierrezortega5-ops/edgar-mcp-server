#!/usr/bin/env node
/**
 * market-signals-mcp: free, keyless market-expectation data that complements edgar-mcp-server.
 * Options-implied moves and probabilities (Cboe), the market-implied Fed path (fed funds futures
 * and Kalshi), Treasury auction demand, an economic calendar with consensus forecasts, CFTC
 * positioning, Fear & Greed, prediction markets, earnings consensus and short interest.
 *
 * Transports: stdio (default) or streamable HTTP (TRANSPORT=http, PORT=3000). No API keys
 * needed, except BANXICO_TOKEN for the optional Banco de México tool.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "../constants.js";
import { serve } from "../transport.js";
import { registerSignalTools } from "./tools.js";

export function createSignalsServer(): McpServer {
  const server = new McpServer(
    { name: "market-signals-mcp", version: VERSION },
    {
      instructions:
        "Market expectations rather than opinions. Before forecasting a move, read what markets already price: options_get_implied_move (expected move, risk-neutral probabilities, skew; event_date isolates earnings), " +
        "rates_get_fed_probabilities (FOMC odds from futures and Kalshi), calendar_get_economic_events (consensus forecasts for releases), positioning_get_cot (crowded futures positioning), " +
        "sentiment_get_fear_greed and sentiment_get_prediction_markets (crowd sentiment as numbers), earnings_get_expectations (consensus, revisions, surprises and the priced move), " +
        "rates_get_treasury_auctions (bond demand) and stocks_get_short_interest. Data are delayed or end-of-day; say so when timing matters.",
    },
  );
  registerSignalTools(server);
  return server;
}

serve("market-signals-mcp", createSignalsServer);
