/**
 * Shared transports for the servers in this package: stdio (default) or stateless streamable
 * HTTP (TRANSPORT=http, PORT=3000, HOST=127.0.0.1, optional ALLOWED_HOSTS and MCP_AUTH_TOKEN).
 */
import { timingSafeEqual } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const jsonRpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

/** Constant-time check of an `Authorization: Bearer <token>` header. */
function hasBearer(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function runStdio(name: string, createServer: () => McpServer): Promise<void> {
  await createServer().connect(new StdioServerTransport());
  console.error(`${name} running on stdio`);
}

/**
 * Stateless streamable HTTP. Host-header validation guards against DNS rebinding (automatic on
 * localhost; set ALLOWED_HOSTS when binding elsewhere) and MCP_AUTH_TOKEN requires a bearer token.
 */
async function runHttp(name: string, createServer: () => McpServer): Promise<void> {
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
  app.listen(port, host, () => console.error(`${name} listening on http://${host}:${port}/mcp`));
}

/** Start `createServer` on the transport selected by TRANSPORT; exit on a fatal error. */
export function serve(name: string, createServer: () => McpServer): void {
  (process.env.TRANSPORT === "http" ? runHttp(name, createServer) : runStdio(name, createServer)).catch((err) => {
    console.error("Server error:", err);
    process.exit(1);
  });
}
