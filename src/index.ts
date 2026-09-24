#!/usr/bin/env node
/**
 * MCP server for free public financial data: SEC EDGAR (financials, filings, insider trades,
 * 13F portfolios), US Treasury yields, FRED and World Bank macro data, and stock prices.
 *
 * Transports: stdio (default) or streamable HTTP (TRANSPORT=http, PORT=3000).
 * Requires SEC_USER_AGENT ("Your Name your.email@example.com"), as mandated by the SEC.
 */
import { timingSafeEqual } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { VERSION } from "./constants.js";
import { registerPrompts } from "./prompts.js";
import { registerCompanyTools } from "./tools/companies.js";
import { registerFinancialTools } from "./tools/financials.js";
import { registerHoldingsTools } from "./tools/holdings.js";
import { registerInsiderTools } from "./tools/insiders.js";
import { registerMacroTools } from "./tools/macro.js";
import { registerMarketTools } from "./tools/market.js";

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

async function runStdio(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
  console.error("edgar-mcp-server running on stdio");
}

const jsonRpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

/** Constant-time check of an `Authorization: Bearer <token>` header. */
function hasBearer(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Stateless streamable HTTP. Host-header validation guards against DNS rebinding (automatic on
 * localhost; set ALLOWED_HOSTS when binding elsewhere) and MCP_AUTH_TOKEN requires a bearer token.
 */
async function runHttp(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  const allowedHosts = process.env.ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean);
  const token = process.env.MCP_AUTH_TOKEN;
  const isLocal = ["127.0.0.1", "localhost", "::1"].includes(host);
  if (!isLocal && !token) console.error(`WARNING: listening on ${host} without MCP_AUTH_TOKEN; anyone who can reach this port can use the server.`);

  const app = createMcpExpressApp({ host, allowedHosts });
  if (token) {
    app.use("/mcp", (req, res, next) => {
      if (hasBearer(req.headers.authorization, token)) return next();
      res.status(401).set("WWW-Authenticate", "Bearer").json(jsonRpcError(-32001, "Unauthorized."));
    });
  }
  app.post("/mcp", async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("Error handling MCP request:", err);
      if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, "Internal server error."));
    }
  });
  // Stateless server: no SSE stream to open (GET) and no session to end (DELETE).
  app.all("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST").json(jsonRpcError(-32000, "Method not allowed."));
  });
  app.listen(port, host, () => console.error(`edgar-mcp-server listening on http://${host}:${port}/mcp`));
}

const ua = process.env.SEC_USER_AGENT?.trim();
if (!ua || ua.startsWith("${")) {
  console.error('ERROR: SEC_USER_AGENT is required by the SEC, e.g. SEC_USER_AGENT="Jane Doe jane@example.com".');
  process.exit(1);
}
if (!ua.includes("@")) console.error(`WARNING: SEC_USER_AGENT "${ua}" has no email address; the SEC may block requests without a contact.`);

(process.env.TRANSPORT === "http" ? runHttp() : runStdio()).catch((err) => {
  console.error("Server error:", err);
  process.exit(1);
});
