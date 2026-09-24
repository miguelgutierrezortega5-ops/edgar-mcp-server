import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dateField, fmtNum, mdTable, render, responseFormatField } from "../services/format.js";
import {
  FRED_FREQUENCIES,
  FRED_TRANSFORMS,
  fredInfo,
  getFredSeries,
  getWorldBankIndicator,
  resolveCountry,
  searchFred,
  WB_INDICATORS,
  type FredTransform,
  type Observation,
} from "../services/macro.js";
import { registerReadTool } from "./register.js";

const TRANSFORM_LABELS: Record<FredTransform, string> = {
  level: "level",
  change: "change from previous period",
  change_yoy: "change from a year ago",
  pct_change: "% change from previous period",
  pct_change_yoy: "% change from a year ago",
  pct_change_annualized: "% change, annualized",
  log: "natural log",
};

function sample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = (items.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => items[Math.round(i * step)]);
}

/** Value about one year before the last observation (for a quick YoY read). */
function yearEarlier(obs: Observation[]): Observation | undefined {
  const last = obs.at(-1);
  if (!last) return undefined;
  const target = Date.parse(last.date) - 365 * 86_400_000;
  let best: Observation | undefined;
  for (const o of obs) if (o.value !== null && Date.parse(o.date) <= target) best = o;
  return best && target - Date.parse(best.date) < 40 * 86_400_000 ? best : undefined;
}

const fmtVal = (v: number | null | undefined) => (v === null || v === undefined ? "–" : Math.abs(v) >= 1e4 ? fmtNum(v) : String(Number(v.toFixed(4))));

export function registerMacroTools(server: McpServer): void {
  registerReadTool(
    server,
    "macro_get_series",
    {
      title: "Get economic data series (FRED)",
      description: `Get US and global economic time series from FRED (Federal Reserve Bank of St. Louis, 800,000+ series): interest rates, inflation, GDP, jobs, money supply, credit spreads, FX, commodities, recession indicators.
Pass 1-5 series IDs to line them up by date. Common IDs: DGS10 / DGS2 (Treasury yields), T10Y2Y (yield curve), FEDFUNDS, CPIAUCSL / CPILFESL (CPI / core), PCEPILFE (core PCE), UNRATE, PAYEMS, GDPC1 (real GDP), A191RL1Q225SBEA (GDP growth), M2SL, BAMLH0A0HYM2 (high-yield spread), VIXCLS, DCOILWTICO (oil), DEXUSEU / DEXMXUS (FX), USREC.
Use transform 'pct_change_yoy' for inflation rates from price indexes, and frequency to aggregate daily data (e.g. monthly averages). Find other IDs with macro_search_series.`,
      inputSchema: {
        series_ids: z
          .array(z.string().regex(/^[A-Za-z0-9_.]{1,40}$/, "A FRED series ID such as 'DGS10'"))
          .min(1)
          .max(5)
          .describe("FRED series IDs, e.g. ['DGS10','DGS2'] or ['CPIAUCSL']."),
        start_date: dateField("First observation date. Default: 10 years ago"),
        end_date: dateField("Last observation date. Default: latest"),
        transform: z.enum(Object.keys(FRED_TRANSFORMS) as [FredTransform, ...FredTransform[]]).default("level").describe("'level' (default), 'change', 'change_yoy', 'pct_change', 'pct_change_yoy', 'pct_change_annualized' or 'log'."),
        frequency: z.enum(Object.keys(FRED_FREQUENCIES) as [keyof typeof FRED_FREQUENCIES, ...(keyof typeof FRED_FREQUENCIES)[]]).optional().describe("Aggregate to a lower frequency: 'weekly', 'monthly', 'quarterly', 'annual'."),
        aggregation: z.enum(["avg", "sum", "eop"]).default("avg").describe("How to aggregate when `frequency` is set: average (default), sum or end of period."),
        max_points: z.number().int().min(2).max(500).default(30).describe("Rows in the table (default 30, evenly sampled; the latest value is always included)."),
        response_format: responseFormatField,
      },
    },
    async ({ series_ids, start_date, end_date, transform, frequency, aggregation, max_points, response_format }) => {
      const ids = [...new Set(series_ids.map((s) => s.toUpperCase()))];
      const start = start_date ?? new Date(Date.now() - 10 * 365.25 * 86_400_000).toISOString().slice(0, 10);
      const [series, infos] = await Promise.all([
        Promise.all(ids.map((id) => getFredSeries(id, { start, end: end_date, transform, frequency, aggregation }))),
        Promise.all(ids.map((id) => fredInfo(id))),
      ]);
      const summaries = ids.map((id, i) => {
        const obs = series[i].filter((o) => o.value !== null);
        const last = obs.at(-1);
        const prev = obs.at(-2);
        const yago = yearEarlier(obs);
        const values = obs.map((o) => o.value!);
        return {
          id,
          title: infos[i]?.title,
          units: transform === "level" ? infos[i]?.units : TRANSFORM_LABELS[transform],
          frequency: frequency ? FRED_FREQUENCIES[frequency] : infos[i]?.frequency,
          latest: last ? { date: last.date, value: last.value } : undefined,
          previous: prev ? { date: prev.date, value: prev.value } : undefined,
          yearAgo: yago ? { date: yago.date, value: yago.value } : undefined,
          copyright: infos[i]?.copyright,
          min: values.length ? Math.min(...values) : null,
          max: values.length ? Math.max(...values) : null,
          observations: obs.length,
        };
      });

      // Align by date (union of dates, sampled) for the table.
      const byDate = new Map<string, (number | null)[]>();
      series.forEach((obs, i) => {
        for (const o of obs) {
          if (o.value === null) continue;
          const row = byDate.get(o.date) ?? ids.map(() => null);
          row[i] = o.value;
          byDate.set(o.date, row);
        }
      });
      const dates = [...byDate.keys()].sort();
      const rows = sample(dates, max_points).map((date) => ({ date, values: byDate.get(date)! }));

      return render(response_format, { transform, start, end: end_date, series: summaries, rows }, (d) =>
        [
          `# FRED: ${d.series.map((s) => s.title ?? s.id).join(" · ")}`,
          "",
          ...d.series.map(
            (s) =>
              `- **${s.id}**${s.title ? ` — ${s.title}` : ""} (${s.units ?? "units: see fred.stlouisfed.org"}${s.frequency ? `, ${s.frequency.toLowerCase()}` : ""}): latest **${fmtVal(s.latest?.value)}** on ${s.latest?.date ?? "–"}` +
              `${s.previous ? `; previous ${fmtVal(s.previous.value)} (${s.previous.date})` : ""}${s.yearAgo ? `; a year earlier ${fmtVal(s.yearAgo.value)} (${s.yearAgo.date})` : ""}; range since ${d.start}: ${fmtVal(s.min)} – ${fmtVal(s.max)}.`,
          ),
          "",
          mdTable(["Date", ...d.series.map((s) => s.id)], d.rows.map((r) => [r.date, ...r.values.map(fmtVal)])),
          "",
          ...d.series
            .filter((s) => s.copyright)
            .map((s) => `⚠️ ${s.id} is copyrighted by ${s.copyright}: FRED allows personal use only; other uses need the owner's permission.`),
          `_Source: FRED, Federal Reserve Bank of St. Louis (https://fred.stlouisfed.org/series/${d.series[0].id}). ${d.transform !== "level" ? `Transform: ${TRANSFORM_LABELS[d.transform]}.` : ""}_`,
        ].join("\n"),
      );
    },
  );

  registerReadTool(
    server,
    "macro_search_series",
    {
      title: "Search economic data series (FRED)",
      description: `Find FRED series IDs by keyword, e.g. 'mortgage rate', 'core inflation', 'unemployment', 'yen', 'high yield'.
Searches all 800,000+ FRED series when the server has a (free) FRED_API_KEY; otherwise a built-in catalog of ~50 key US series.`,
      inputSchema: {
        query: z.string().min(2).max(100).describe("Keywords."),
        limit: z.number().int().min(1).max(50).default(15).describe("Maximum results (default 15)."),
        response_format: responseFormatField,
      },
    },
    async ({ query, limit, response_format }) => {
      const res = await searchFred(query, limit);
      return render(response_format, res, (d) =>
        [
          `# FRED series matching '${query}'`,
          "",
          d.hits.length ? mdTable(["ID", "Title", "Units", "Frequency"], d.hits.map((h) => [h.id, h.title, h.units, h.frequency])) : "_No matches._",
          "",
          d.source === "catalog"
            ? "_Searched the built-in catalog. Set FRED_API_KEY (free at https://fredaccount.stlouisfed.org/apikeys) to search every FRED series. Any ID from fred.stlouisfed.org also works directly with macro_get_series._"
            : "_Source: FRED API, sorted by popularity. This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis._",
        ].join("\n"),
      );
    },
  );

  const indicatorKeys = Object.keys(WB_INDICATORS);
  registerReadTool(
    server,
    "macro_get_country_indicator",
    {
      title: "Get country macro indicators (World Bank)",
      description: `Get annual macroeconomic indicators for any country (or aggregates like 'WLD' world, 'EUU' EU) from the World Bank, e.g. to compare the markets a company sells in.
Indicators: ${indicatorKeys.join(", ")}; or any World Bank indicator ID (e.g. 'NY.GDP.MKTP.KD.ZG'). Data are annual and usually lag 6-18 months.`,
      inputSchema: {
        countries: z.array(z.string().min(2).max(60)).min(1).max(10).describe("ISO codes or English names, e.g. ['MX','US','Spain']."),
        indicator: z.string().min(2).max(60).describe(`One of ${indicatorKeys.join(", ")}, or a World Bank indicator ID.`),
        start_year: z.number().int().min(1960).max(2100).optional().describe("First year. Default: 10 years ago."),
        end_year: z.number().int().min(1960).max(2100).optional().describe("Last year. Default: current year."),
        response_format: responseFormatField,
      },
    },
    async ({ countries, indicator, start_year, end_year, response_format }) => {
      const thisYear = new Date().getUTCFullYear();
      const end = end_year ?? thisYear;
      const start = start_year ?? end - 10;
      const known = WB_INDICATORS[indicator.toLowerCase()];
      const id = known?.id ?? indicator;
      if (!/^[A-Za-z0-9_.]+$/.test(id)) throw new Error(`Unknown indicator '${indicator}'. Use one of: ${indicatorKeys.join(", ")}.`);
      const resolved = await Promise.all(countries.map(resolveCountry));
      const { label, rows } = await getWorldBankIndicator(
        resolved.map((c) => c.id),
        id,
        start,
        end,
      );
      const years = [...new Set(rows.filter((r) => r.value !== null).map((r) => r.year))].sort((a, b) => a - b);
      const names = resolved.map((c) => c.name);
      const table = years.map((y) => [y, ...resolved.map((c) => rows.find((r) => r.year === y && r.countryCode === c.id)?.value ?? null)]);
      const isPct = /%|rate/i.test(label);
      return render(response_format, { indicator: id, label: known?.label ?? label, countries: resolved.map((c) => ({ code: c.id, name: c.name })), rows }, (d) =>
        years.length
          ? [
              `# ${d.label}`,
              "",
              mdTable(["Year", ...names], table.map(([y, ...vals]) => [y, ...vals.map((v) => (v === null ? "–" : isPct ? `${(v as number).toFixed(2)}` : fmtNum(v)))])),
              "",
              `_Source: World Bank, World Development Indicators (${d.indicator}), CC BY 4.0._`,
            ].join("\n")
          : `No ${d.label} data for ${names.join(", ")} in ${start}–${end}.`,
      );
    },
  );
}
