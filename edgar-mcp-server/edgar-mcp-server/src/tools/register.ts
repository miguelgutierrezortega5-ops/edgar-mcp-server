import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { errorResult } from "../services/format.js";

/** Register a read-only Fiscal.ai tool; thrown errors become actionable isError results. */
export function registerReadTool<S extends ZodRawShape>(
  server: McpServer,
  name: string,
  config: { title: string; description: string; inputSchema: S },
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>,
): void {
  const run = async (args: z.infer<z.ZodObject<S>>): Promise<CallToolResult> => {
    try {
      return await handler(args);
    } catch (e) {
      return errorResult(e);
    }
  };
  server.registerTool(
    name,
    {
      ...config,
      annotations: { title: config.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    run as never,
  );
}
