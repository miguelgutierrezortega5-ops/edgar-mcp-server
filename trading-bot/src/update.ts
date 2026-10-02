import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

// Updates from GitHub: the bot runs from a git clone, so new versions arrive as commits on the branch
// it tracks. The bot announces them and /actualizar installs them; with `updates.auto` (simulated
// accounts only) it installs them by itself. A version that fails to build is undone on the spot; one
// that cannot start is undone by the supervisor (scripts/android/supervisor.sh), which reads the
// commit to go back to from PREVIOUS_FILE and marks the failed one so it is not installed again.

const exec = promisify(execFile);

/** Exit code that asks the supervisor (scripts/android/supervisor.sh) to start the bot again. */
export const RESTART_CODE = 75;

/** Commit to return to while a freshly installed version has not proven it starts (deleted once it runs). */
export const PREVIOUS_FILE = ".actualizacion-previa";
/** Commit that failed to start: automatic updates skip it until a newer one arrives. */
export const FAILED_FILE = ".actualizacion-fallida";
/** Left by the supervisor after going back, so the bot tells the owner. */
export const NOTICE_FILE = ".actualizacion-aviso";

async function run(cmd: string, args: string[], dir: string, timeout: number): Promise<string> {
  try {
    return (await exec(cmd, args, { cwd: dir, timeout, shell: process.platform === "win32" && cmd === "npm" })).stdout.trim();
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const detail = (e.stderr?.trim() || e.message).split("\n").slice(-3).join(" ");
    throw new Error(`${cmd} ${args[0]}: ${detail}`);
  }
}

const git = (dir: string, ...args: string[]) => run("git", args, dir, 120_000);

export interface Version {
  commit: string;
  date: string;
}

/** Commit and date of the running copy; null outside a git clone. */
export async function currentVersion(dir: string): Promise<Version | null> {
  try {
    const [commit, date] = (await git(dir, "log", "-1", "--format=%h %cs")).split(" ");
    return { commit, date };
  } catch {
    return null;
  }
}

export const describeVersion = (v: Version | null) => (v ? `versión ${v.commit} del ${v.date}` : "versión sin git");

/** Subjects of the commits on the tracked branch that this copy lacks, newest first; null when it can't tell. */
export async function pendingUpdates(dir: string): Promise<string[] | null> {
  try {
    await git(dir, "fetch", "--quiet");
    const out = await git(dir, "log", "--format=%s", "HEAD..@{u}");
    return out ? out.split("\n") : [];
  } catch {
    return null;
  }
}

const npmInstall = (dir: string) => run("npm", ["install", "--no-fund", "--no-audit"], dir, 600_000);

/** Brings in the pending commits and rebuilds; returns their subjects (empty when already current). */
export async function applyUpdate(dir: string, install = true): Promise<string[]> {
  const pending = await pendingUpdates(dir);
  if (pending === null) throw new Error("no pude consultar GitHub (sin conexión, o esta copia no es un clon de git)");
  if (!pending.length) return [];
  const before = await git(dir, "rev-parse", "HEAD");
  await git(dir, "merge", "--ff-only", "@{u}");
  if (install) {
    try {
      await npmInstall(dir);
    } catch (err) {
      await git(dir, "reset", "--hard", "--quiet", before);
      await npmInstall(dir).catch(() => undefined);
      writeFileSync(join(dir, FAILED_FILE), await git(dir, "rev-parse", "@{u}"));
      throw new Error(`la versión nueva no se pudo instalar y sigo con la anterior (${(err as Error).message})`);
    }
  }
  writeFileSync(join(dir, PREVIOUS_FILE), before);
  return pending;
}

/** The newest commit on the tracked branch, when automatic updates must skip it (it failed before). */
export async function failedUpdate(dir: string): Promise<string | null> {
  const file = join(dir, FAILED_FILE);
  if (!existsSync(file)) return null;
  const failed = readFileSync(file, "utf8").trim();
  try {
    return (await git(dir, "rev-parse", "@{u}")) === failed ? failed : null;
  } catch {
    return null;
  }
}

/** The running version has worked for a while: forget the way back. */
export function confirmUpdate(dir: string): void {
  rmSync(join(dir, PREVIOUS_FILE), { force: true });
}

/** The supervisor's note after it went back to the previous version, read once. */
export function takeRollbackNotice(dir: string): string | null {
  const file = join(dir, NOTICE_FILE);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8").trim();
  rmSync(file, { force: true });
  return text;
}

export function listUpdates(subjects: string[], max = 8): string {
  const shown = subjects.slice(0, max).map((s) => `• ${s}`);
  if (subjects.length > max) shown.push(`… y ${subjects.length - max} más`);
  return shown.join("\n");
}
