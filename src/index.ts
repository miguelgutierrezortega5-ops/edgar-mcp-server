#!/usr/bin/env node
/**
 * MCP server for free public financial data: SEC EDGAR (financials, filings, insider trades,
 * 13F portfolios), US Treasury yields, FRED and World Bank macro data, and stock prices.
 *
 * Transports: stdio (default) or streamable HTTP (TRANSPORT=http, PORT=3000).
 * Requires SEC_USER_AGENT ("Your Name your.email@example.com"), as mandated by the SEC.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "./constants.js";
import { registerPrompts } from "./prompts.js";
import { registerCompanyTools } from "./tools/companies.js";
import { registerFinancialTools } from "./tools/financials.js";
import { registerHoldingsTools } from "./tools/holdings.js";
import { registerInsiderTools } from "./tools/insiders.js";
import { registerMacroTools } from "./tools/macro.js";
import { registerMarketTools } from "./tools/market.js";
import { serve } from "./transport.js";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "edgar-mcp-server", version: VERSION },
    {
      instructions:
        "Free public financial data. SEC EDGAR covers companies that file with the SEC (US listed companies and foreign issuers filing 20-F/40-F). " +
        "Identify companies by ticker, CIK or name. Start with edgar_get_key_metrics for a quick overview; edgar_get_financial_statement for full statements; " +
        "edgar_read_filing(section='risk_factors'|'mdna'|'business') for qualitative analysis; market_get_valuation for multiples. " +
        "edgar_get_institutional_holdings shows a fund's 13F portfolio; macro_get_series (FRED) and macro_get_country_indicator (World Bank) cover the economy.",
    },
  );
  registerCompanyTools(server);
  registerFinancialTools(server);
  registerInsiderTools(server);
  registerHoldingsTools(server);
  registerMarketTools(server);
  registerMacroTools(server);
  registerPrompts(server);
  return server;
}

const ua = process.env.SEC_USER_AGENT?.trim();
if (!ua || ua.startsWith("${")) {
  console.error('ERROR: SEC_USER_AGENT is required by the SEC, e.g. SEC_USER_AGENT="Jane Doe jane@example.com".');
  process.exit(1);
}
if (!ua.includes("@")) console.error(`WARNING: SEC_USER_AGENT "${ua}" has no email address; the SEC may block requests without a contact.`);

serve("edgar-mcp-server", createServer);
