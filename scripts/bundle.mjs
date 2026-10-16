#!/usr/bin/env node
// Build the Claude Desktop extension (build/edgar-mcp-server-<version>.mcpb) and a zip of each
// skill in skills/ for claude.ai / Claude Desktop (Settings → Capabilities → Skills).
// Run with `npm run bundle` (it builds first).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

// 2–3. One extension per server: manifest with the tool list taken from the server itself (so it
// never drifts), then validate and pack. Both share the staged files.
const EXTENSIONS = [
  { manifest: "manifest.json", entry: join("dist", "index.js"), env: { SEC_USER_AGENT: "bundle build@example.com" } },
  { manifest: "manifest-signals.json", entry: join("dist", "signals", "index.js"), env: {} },
];
const files = [];
for (const ext of EXTENSIONS) {
  const client = new Client({ name: "bundle", version: pkg.version });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(stage, ext.entry)], env: { ...process.env, ...ext.env } }));
  const { tools } = await client.listTools();
  await client.close();
  const manifest = JSON.parse(readFileSync(join(root, ext.manifest), "utf8"));
  if (manifest.version !== pkg.version) throw new Error(`${ext.manifest} version ${manifest.version} ≠ package.json ${pkg.version}`);
  manifest.tools = tools.map((t) => ({ name: t.name, description: (t.description ?? "").split("\n")[0] }));
  writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const file = join(out, `${manifest.name}-${pkg.version}.mcpb`);
  rmSync(file, { force: true });
  sh("npx", ["-y", MCPB, "validate", join(stage, "manifest.json")]);
  sh("npx", ["-y", MCPB, "pack", stage, file]);
  files.push({ file, tools: tools.length });
}

// 4. One zip per skill (needs the `zip` command, present on macOS/Linux and GitHub runners).
const skillZips = [];
for (const name of readdirSync(join(root, "skills"))) {
  const skillZip = join(out, `${name}-skill.zip`);
  try {
    rmSync(skillZip, { force: true });
    execFileSync("zip", ["-rq", skillZip, name, "-x", "*__pycache__*"], { cwd: join(root, "skills") });
    skillZips.push(skillZip);
  } catch {
    console.warn(`\`zip\` not found: skipped ${name}-skill.zip.`);
  }
}

for (const f of files) console.log(`\n${f.tools} tools · ${f.file} (${(statSync(f.file).size / 1e6).toFixed(1)} MB)`);
for (const z of skillZips) console.log(`Skill: ${z}`);
