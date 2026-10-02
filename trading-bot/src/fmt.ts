export const price = (v: number): string => (Number.isFinite(v) ? String(Number(v.toPrecision(6))) : "—");
export const money = (v: number, ccy: string): string => `${v < 0 ? "-" : ""}${Math.abs(v).toFixed(2)} ${ccy}`;
export const pct = (v: number): string => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "—");
export const time = (t: number): string => new Date(t).toISOString().slice(0, 16).replace("T", " ");
export const side = (s: "long" | "short"): string => (s === "long" ? "larga" : "corta");

/** Plain-text table with aligned columns. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}
