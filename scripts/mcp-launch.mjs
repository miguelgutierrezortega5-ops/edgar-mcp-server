#!/usr/bin/env node
// Starts the MCP server declared in .mcp.json, building it first on a fresh checkout.
//
//   node scripts/mcp-launch.mjs            start the server (stdio)
//   node scripts/mcp-launch.mjs --prepare  install dependencies and build, then exit (SessionStart hook)
//
// Both modes take the same lock, so the server never starts from a half-written dist/ while the hook rebuilds it.
// Build output goes to stderr: stdout carries the MCP protocol.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "dist", "index.js");
const lock = join(root, ".mcp-build.lock");
const run = (cmd) => execSync(cmd, { cwd: root, stdio: ["ignore", 2, 2] });

async function withLock(fn) {
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // A build never takes this long: the holder died, so take over its lock.
      const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > 180_000) rmSync(lock, { recursive: true, force: true });
      else await sleep(500);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

if (process.argv.includes("--prepare")) {
  await withLock(() => {
    run("npm install --no-audit --no-fund");
    run("npm run build");
  });
} else {
  await withLock(() => {
    if (existsSync(entry)) return;
    if (!existsSync(join(root, "node_modules"))) run("npm install --no-audit --no-fund");
    run("npm run build");
  });
  await import(pathToFileURL(entry).href);
}
