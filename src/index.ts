#!/usr/bin/env node
/**
 * MCP server for free public financial data: SEC EDGAR, US Treasury yields and stock prices.
 *
 * Transports: stdio (default) or streamable HTTP (TRANSPORT=http, PORT=3000).
 * Requires SEC_USER_AGENT ("Your Name your.email@example.com"), as mandated by the SEC.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { registerCompanyTools } from "./tools/companies.js";
import { registerFinancialTools } from "./tools/financials.js";
import { registerInsiderTools } from "./tools/insiders.js";
import { registerMarketTools } from "./tools/market.js";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "edgar-mcp-server", version: "1.0.0" },
    {
      instructions:
        "Free public financial data. SEC EDGAR covers companies that file with the SEC (US listed companies and foreign issuers filing 20-F/40-F). " +
        "Identify companies by ticker, CIK or name. Start with edgar_get_key_metrics for a quick overview; edgar_get_financial_statement for full statements; " +
        "edgar_read_filing(section='risk_factors'|'mdna'|'business') for qualitative analysis; market_get_valuation for multiples.",
    },
  );
  registerCompanyTools(server);
  registerFinancialTools(server);
  registerInsiderTools(server);
  registerMarketTools(server);
  return server;
}

async function runStdio(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
  console.error("edgar-mcp-server running on stdio");
}

async function runHttp(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post("/mcp", async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  app.listen(port, host, () => console.error(`edgar-mcp-server listening on http://${host}:${port}/mcp`));
}

if (!process.env.SEC_USER_AGENT) {
  console.error('ERROR: SEC_USER_AGENT is required by the SEC, e.g. SEC_USER_AGENT="Jane Doe jane@example.com".');
  process.exit(1);
}

(process.env.TRANSPORT === "http" ? runHttp() : runStdio()).catch((err) => {
  console.error("Server error:", err);
  process.exit(1);
});
