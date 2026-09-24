#!/usr/bin/env node
// Build the Claude Desktop extension (build/edgar-mcp-server-<version>.mcpb) and a zip of the
// analysis skill for claude.ai / Claude Desktop (Settings → Capabilities → Skills).
// Run with `npm run bundle` (it builds first).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MCPB = "@anthropic-ai/mcpb@2.1.2";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "build");
const stage = join(out, "bundle");
const isWin = process.platform === "win32";
const sh = (cmd, args, cwd = root) => execFileSync(isWin ? `${cmd}.cmd` : cmd, args, { cwd, stdio: "inherit", shell: isWin });

if (!existsSync(join(root, "dist", "index.js"))) throw new Error("Run `npm run build` first.");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// 1. Server files and production dependencies only.
for (const f of ["dist", "skills", "README.md", "LICENSE", "package.json", "package-lock.json"]) cpSync(join(root, f), join(stage, f), { recursive: true });
sh("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);

// 2. Manifest, with the tool list taken from the server itself so it never drifts.
const client = new Client({ name: "bundle", version: pkg.version });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(stage, "dist", "index.js")], env: { ...process.env, SEC_USER_AGENT: "bundle build@example.com" } }));
const { tools } = await client.listTools();
await client.close();
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
if (manifest.version !== pkg.version) throw new Error(`manifest.json version ${manifest.version} ≠ package.json ${pkg.version}`);
manifest.tools = tools.map((t) => ({ name: t.name, description: (t.description ?? "").split("\n")[0] }));
writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// 3. Validate and pack.
const file = join(out, `edgar-mcp-server-${pkg.version}.mcpb`);
rmSync(file, { force: true });
sh("npx", ["-y", MCPB, "validate", join(stage, "manifest.json")]);
sh("npx", ["-y", MCPB, "pack", stage, file]);

// 4. Skill zip (needs the `zip` command, present on macOS/Linux and GitHub runners).
const skillZip = join(out, "sec-financial-analysis-skill.zip");
try {
  rmSync(skillZip, { force: true });
  execFileSync("zip", ["-rq", skillZip, "sec-financial-analysis"], { cwd: join(root, "skills") });
} catch {
  console.warn("`zip` not found: skipped the skill zip.");
}

console.log(`\n${tools.length} tools · ${file} (${(statSync(file).size / 1e6).toFixed(1)} MB)`);
if (existsSync(skillZip)) console.log(`Skill: ${skillZip}`);
