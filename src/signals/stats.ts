/** Small numeric helpers shared by the market-signals sources. */

/** Standard normal CDF (Abramowitz & Stegun 7.1.26), absolute error < 1.5e-7. */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Share of `values` at or below `v` (0–1). */
export function percentileRank(values: number[], v: number): number {
  return values.length ? values.filter((x) => x <= v).length / values.length : NaN;
}

export function zScore(values: number[], v: number): number {
  if (values.length < 2) return NaN;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
  return sd > 0 ? (v - mean) / sd : NaN;
}

export const pct = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "–" : `${(v * 100).toFixed(digits)}%`;

export const signedPct = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "–" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;

/** Parse "$1,234.5" / "1,234" / "(3.2)" style numbers; null when empty. */
export function parseNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s === "N/A" || s === "--") return null;
  const neg = /^\(.*\)$/.test(s) || s.startsWith("-");
  const n = Number(s.replace(/[$,%()\s+-]/g, ""));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** YYYY-MM-DD of a Date in UTC. */
export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** Format an ISO timestamp in an IANA time zone, e.g. "Thu 2026-10-15 05:30". */
export function inZone(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}
