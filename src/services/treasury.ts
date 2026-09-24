import { httpGet } from "./http.js";

export interface YieldCurve {
  date: string;
  yields: Record<string, number | null>;
}

/** Parse treasury.gov's daily par yield curve CSV (MM/DD/YYYY dates), newest first. */
export function parseYieldCsv(csv: string): YieldCurve[] {
  const [header, ...lines] = csv.trim().split(/\r?\n/).filter(Boolean);
  if (!header || !lines.length) return [];
  const cols = header.split(",").map((c) => c.replace(/"/g, ""));
  return lines
    .map((l) => {
      const v = l.split(",");
      const [mm, dd, yyyy] = v[0].replace(/"/g, "").split("/");
      return { date: `${yyyy}-${mm}-${dd}`, yields: Object.fromEntries(cols.slice(1).map((c, i) => [c, v[i + 1] === "" ? null : Number(v[i + 1])])) };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

function fetchYear(year: number): Promise<string> {
  return httpGet<string>(
    "treasury",
    `/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`,
    { as: "text", ttl: 60 * 60 * 1000 },
  );
}

/**
 * Yield curve for the latest trading day on or before `date` (default: today). Falls back to
 * the previous year when the requested one has no trading day yet on or before that date
 * (e.g. 1 January, or early January before the first release).
 */
export async function getYieldCurve(date?: string): Promise<YieldCurve> {
  const target = date ?? new Date().toISOString().slice(0, 10);
  const year = Number(target.slice(0, 4));
  for (const y of [year, year - 1]) {
    const row = parseYieldCsv(await fetchYear(y)).find((r) => r.date <= target);
    if (row) return row;
  }
  throw new Error(`No Treasury yield curve data on or before ${target}.`);
}
