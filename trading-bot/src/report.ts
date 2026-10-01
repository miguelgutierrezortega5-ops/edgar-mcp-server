import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Daily report for Claude, authorized by the owner: the phone is the copy that sees live futures, and
// Claude cannot read what the bot says on Telegram (bots can't read their own messages). So the bot
// sends a JSON file to the owner's chat and pins it; with the bot's token Claude finds it
// (getChat → pinned message) and learns from it. It carries no keys or tokens.

/** Last log lines (signals ignored and why, errors), kept for the report. */
export const logTail: string[] = [];
const TAIL = 400;

export function remember(line: string): void {
  logTail.push(line);
  if (logTail.length > TAIL) logTail.splice(0, logTail.length - TAIL);
}

const fileOf = (dir: string) => join(dir, "informe.json");

/** True when no report was sent in the last `hours` (or ever). */
export function reportDue(dir: string, hours: number, now: number): boolean {
  if (!(hours > 0)) return false;
  if (!existsSync(fileOf(dir))) return true;
  const { enviadoEn } = JSON.parse(readFileSync(fileOf(dir), "utf8")) as { enviadoEn: number };
  return now - enviadoEn >= hours * 3_600_000;
}

export function markReported(dir: string, now: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(fileOf(dir), JSON.stringify({ enviadoEn: now }));
}

/** Telegram caption limit is 1024 characters. */
export const caption = (text: string) => (text.length > 1000 ? `${text.slice(0, 999)}…` : text);
