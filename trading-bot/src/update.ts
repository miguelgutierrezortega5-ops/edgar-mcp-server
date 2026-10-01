import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Updates from GitHub: the bot runs from a git clone, so new versions arrive as commits on the branch
// it tracks. The bot only announces them; installing waits for the owner's /actualizar.

const exec = promisify(execFile);

/** Exit code that asks the supervisor (scripts/android/supervisor.sh) to start the bot again. */
export const RESTART_CODE = 75;

/** How often the bot looks for new versions. */
export const UPDATE_CHECK_HOURS = 6;

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

/** Brings in the pending commits and rebuilds; returns their subjects (empty when already current). */
export async function applyUpdate(dir: string, install = true): Promise<string[]> {
  const pending = await pendingUpdates(dir);
  if (pending === null) throw new Error("no pude consultar GitHub (sin conexión, o esta copia no es un clon de git)");
  if (!pending.length) return [];
  await git(dir, "merge", "--ff-only", "@{u}");
  if (install) await run("npm", ["install", "--no-fund", "--no-audit"], dir, 600_000);
  return pending;
}

export function listUpdates(subjects: string[], max = 8): string {
  const shown = subjects.slice(0, max).map((s) => `• ${s}`);
  if (subjects.length > max) shown.push(`… y ${subjects.length - max} más`);
  return shown.join("\n");
}
