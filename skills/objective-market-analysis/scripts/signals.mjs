// Command-line client for this repo's market-signals-mcp server (dist/signals, built with `npm run build`).
// Usage: node signals.mjs tool '{"arg":1}'   or   node signals.mjs --batch '[["tool",{...}],["tool2",{...}]]'
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const sdk = `${REPO}node_modules/@modelcontextprotocol/sdk/dist/esm/client`;
const { Client } = await import(`${sdk}/index.js`);
const { StdioClientTransport } = await import(`${sdk}/stdio.js`);
const client = new Client({ name: "signals-cli", version: "0" });
await client.connect(new StdioClientTransport({
  command: "node",
  args: [`${REPO}dist/signals/index.js`],
  env: { ...process.env, SEC_USER_AGENT: process.env.SEC_USER_AGENT ?? "edgar-mcp-server signals-cli contact@example.com" },
  stderr: "ignore",
}));
const [a, b] = process.argv.slice(2);
const calls = a === "--batch" ? JSON.parse(b) : [[a, JSON.parse(b ?? "{}")]];
for (const [name, args] of calls) {
  const r = await client.callTool({ name, arguments: args });
  console.log(`\n===== ${name} ${JSON.stringify(args)}${r.isError ? " [ERROR]" : ""}`);
  console.log(r.content.map((c) => c.text).join("\n"));
}
await client.close();
