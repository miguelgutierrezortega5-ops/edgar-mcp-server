#!/usr/bin/env node
// Instalador: configura Claude Desktop y/o Claude Code para usar este servidor MCP.
//
//   npm run setup                                   (interactivo)
//   npm run setup -- --user-agent "Nombre email@x.com" --yes
//   Opciones: --desktop / --no-desktop, --code / --no-code, --fred-key CLAVE, --dry-run
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "dist", "index.js");
const isWin = platform() === "win32";
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = flag("dry-run");
const yes = flag("yes") || !process.stdin.isTTY;

const log = (s = "") => console.log(s);
const ok = (s) => log(`  ✔ ${s}`);
const warn = (s) => log(`  ⚠ ${s}`);

async function ask(rl, question, fallback) {
  if (yes || !rl) return fallback;
  const answer = (await rl.question(question)).trim();
  return answer || fallback;
}

async function confirm(rl, question, fallback) {
  if (yes || !rl) return fallback;
  const answer = (await rl.question(`${question} ${fallback ? "[S/n]" : "[s/N]"} `)).trim().toLowerCase();
  return answer ? answer.startsWith("s") || answer.startsWith("y") : fallback;
}

/** Candidate claude_desktop_config.json locations (the Microsoft Store build keeps its own copy). */
function desktopConfigPaths() {
  const home = homedir();
  if (platform() === "darwin") return [join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")];
  if (isWin) {
    const paths = [join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")];
    const packages = join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "Packages");
    if (existsSync(packages)) {
      for (const d of readdirSync(packages)) if (/^Claude_/i.test(d)) paths.push(join(packages, d, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
    }
    return paths;
  }
  return [join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "Claude", "claude_desktop_config.json")];
}

function configureDesktop(configPath, server) {
  let config = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8") || "{}");
    } catch (e) {
      warn(`No se pudo leer ${configPath} (${e.message}). Corrígelo o bórralo y vuelve a ejecutar el instalador.`);
      return false;
    }
  }
  config.mcpServers = { ...(config.mcpServers ?? {}), edgar: server };
  if (dryRun) {
    log(`  (simulación) Escribiría en ${configPath}:\n${JSON.stringify({ mcpServers: { edgar: server } }, null, 2)}`);
    return true;
  }
  mkdirSync(dirname(configPath), { recursive: true });
  const hadConfig = existsSync(configPath);
  if (hadConfig) copyFileSync(configPath, `${configPath}.bak`);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  ok(`Claude Desktop configurado: ${configPath}${hadConfig ? " (copia de seguridad de la anterior: .bak)" : ""}`);
  return true;
}

/** On Windows, npm-installed CLIs are .cmd files that need a shell, which does not quote arguments for us. */
const quoteWin = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

function run(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, isWin ? cmdArgs.map(quoteWin) : cmdArgs, { encoding: "utf8", shell: isWin, ...opts });
}

function configureClaudeCode(env) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const addArgs = ["mcp", "add", "--scope", "user", "edgar", ...envArgs, "--", process.execPath, entry];
  if (dryRun) {
    log(`  (simulación) claude ${addArgs.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`);
    return;
  }
  run("claude", ["mcp", "remove", "--scope", "user", "edgar"]); // ignore "not found"
  const res = run("claude", addArgs, { stdio: "pipe" });
  if (res.status === 0) ok("Claude Code configurado (ámbito de usuario: disponible en todos tus proyectos).");
  else warn(`No se pudo registrar en Claude Code: ${(res.stderr || res.stdout || "").trim()}`);
}

function installSkill() {
  const target = join(homedir(), ".claude", "skills", "sec-financial-analysis");
  if (dryRun) {
    log(`  (simulación) Copiaría la skill a ${target}`);
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(root, "skills", "sec-financial-analysis"), target, { recursive: true });
  ok(`Skill de análisis instalada en ${target}`);
}

async function main() {
  log("\nedgar-mcp-server · instalador\n");
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 18) {
    log(`Necesitas Node.js 18 o superior (tienes ${process.versions.node}). Descárgalo en https://nodejs.org`);
    process.exit(1);
  }

  if (!existsSync(entry)) {
    log("Compilando el servidor…");
    const build = run("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
    if (build.status !== 0 || !existsSync(entry)) {
      log("La compilación falló. Ejecuta primero `npm install` en la carpeta del proyecto.");
      process.exit(1);
    }
  }

  const rl = process.stdin.isTTY && !yes ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  try {
    let userAgent = option("user-agent") ?? process.env.SEC_USER_AGENT;
    while (!userAgent || !/\S+\s+\S+@\S+/.test(userAgent)) {
      if (!rl) {
        log('Falta tu nombre y email para la SEC. Usa: npm run setup -- --user-agent "Tu Nombre tu@email.com"');
        process.exit(1);
      }
      userAgent = (await rl.question('La SEC exige identificarse. Escribe tu nombre y email (p. ej. "Juan Pérez juan@correo.com"): ')).trim();
    }
    const fredKey = option("fred-key") ?? process.env.FRED_API_KEY ?? (await ask(rl, "Clave gratuita de FRED (opcional, Enter para omitir): ", ""));

    const env = { SEC_USER_AGENT: userAgent, ...(fredKey ? { FRED_API_KEY: fredKey } : {}) };
    const server = { command: process.execPath, args: [entry], env };

    log("\n1) Claude Desktop");
    const paths = desktopConfigPaths();
    const found = paths.filter((p) => existsSync(dirname(p)));
    const wantDesktop = flag("no-desktop") ? false : flag("desktop") || found.length > 0 ? await confirm(rl, "¿Configurar Claude Desktop?", true) : false;
    if (wantDesktop) for (const p of found.length ? found : paths.slice(0, 1)) configureDesktop(p, server);
    else log(found.length ? "  Omitido." : "  No se encontró Claude Desktop (usa --desktop para configurarlo igualmente).");

    log("\n2) Claude Code");
    const hasClaude = run("claude", ["--version"], { stdio: "pipe" }).status === 0;
    const wantCode = flag("no-code") ? false : flag("code") || hasClaude ? await confirm(rl, "¿Configurar Claude Code e instalar la skill de análisis?", true) : false;
    if (wantCode) {
      if (hasClaude || dryRun) configureClaudeCode(env);
      else warn("No se encontró el comando `claude`; solo se instala la skill.");
      installSkill();
    } else log(hasClaude ? "  Omitido." : "  No se encontró Claude Code (https://claude.com/claude-code).");

    log(`
Listo. Siguientes pasos:
  • Reinicia Claude Desktop (ciérralo del todo, también desde la bandeja del sistema) y abre un chat nuevo.
  • Prueba: "Analiza Microsoft con las herramientas de edgar" o usa las plantillas del menú "+" → edgar.
  • En Claude Code: ejecuta /mcp para comprobar que "edgar" aparece conectado.
`);
  } finally {
    rl?.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
