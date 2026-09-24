import { loadLines, selectPeriods, STATEMENTS } from "./statements.js";
import type { CompanyFacts, PeriodKind, Point } from "./xbrl.js";

export interface MetricDef {
  key: string;
  label: string;
  unit: "money" | "%" | "x" | "per_share";
}

export const KEY_METRICS: MetricDef[] = [
  { key: "revenue", label: "Revenue", unit: "money" },
  { key: "revenue_growth", label: "Revenue growth (YoY)", unit: "%" },
  { key: "gross_margin", label: "Gross margin", unit: "%" },
  { key: "operating_margin", label: "Operating margin", unit: "%" },
  { key: "net_income", label: "Net income", unit: "money" },
  { key: "net_margin", label: "Net margin", unit: "%" },
  { key: "eps_diluted", label: "EPS (diluted)", unit: "per_share" },
  { key: "eps_growth", label: "EPS growth (YoY)", unit: "%" },
  { key: "fcf", label: "Free cash flow", unit: "money" },
  { key: "fcf_margin", label: "FCF margin", unit: "%" },
  { key: "sbc_pct_revenue", label: "SBC / revenue", unit: "%" },
  { key: "roe", label: "ROE (NI / equity)", unit: "%" },
  { key: "roa", label: "ROA (NI / assets)", unit: "%" },
  { key: "current_ratio", label: "Current ratio", unit: "x" },
  { key: "debt_to_equity", label: "LT debt / equity", unit: "x" },
  { key: "net_cash", label: "Net cash (cash + ST inv. − LT debt)", unit: "money" },
  { key: "shareholder_returns", label: "Buybacks + dividends", unit: "money" },
];

export interface MetricsTable {
  periods: string[];
  currency?: string;
  metrics: (MetricDef & { values: (number | null)[] })[];
}

const div = (a?: number | null, b?: number | null) => (a == null || b == null || b === 0 ? null : a / b);
const sub = (a?: number | null, b?: number | null) => (a == null || b == null ? null : a - b);
const growth = (cur?: number | null, prev?: number | null) => (cur == null || prev == null || prev <= 0 ? null : cur / prev - 1);

/** Value of a series at the period ~1 year before `end` (same fiscal quarter for quarterly data). */
function yearAgo(series: Map<string, Point>, end: string): number | null {
  const target = Date.parse(end) - 365 * 86_400_000;
  for (const [e, p] of series) if (Math.abs(Date.parse(e) - target) <= 20 * 86_400_000) return p.val;
  return null;
}

export function computeKeyMetrics(facts: CompanyFacts, kind: PeriodKind, maxPeriods: number): MetricsTable {
  const defs = [...STATEMENTS.income, ...STATEMENTS.balance, ...STATEMENTS.cashflow];
  const lines = loadLines(facts, defs, kind);
  const s = (k: string) => lines.get(k)!.series;
  const periods = selectPeriods([lines.get("revenue")!, lines.get("net_income")!], maxPeriods);
  const v = (k: string, p: string) => s(k).get(p)?.val ?? null;
  const currency = periods.map((p) => s("revenue").get(p)?.unit ?? s("net_income").get(p)?.unit).find(Boolean);

  const compute: Record<string, (p: string) => number | null> = {
    revenue: (p) => v("revenue", p),
    revenue_growth: (p) => growth(v("revenue", p), yearAgo(s("revenue"), p)),
    gross_margin: (p) => div(v("gross_profit", p) ?? sub(v("revenue", p), v("cost_of_revenue", p)), v("revenue", p)),
    operating_margin: (p) => div(v("operating_income", p), v("revenue", p)),
    net_income: (p) => v("net_income", p),
    net_margin: (p) => div(v("net_income", p), v("revenue", p)),
    eps_diluted: (p) => v("eps_diluted", p),
    eps_growth: (p) => growth(v("eps_diluted", p), yearAgo(s("eps_diluted"), p)),
    fcf: (p) => sub(v("cfo", p), v("capex", p)),
    fcf_margin: (p) => div(sub(v("cfo", p), v("capex", p)), v("revenue", p)),
    sbc_pct_revenue: (p) => div(v("sbc", p), v("revenue", p)),
    roe: (p) => (kind === "annual" ? div(v("net_income", p), v("equity", p)) : null),
    roa: (p) => (kind === "annual" ? div(v("net_income", p), v("total_assets", p)) : null),
    current_ratio: (p) => div(v("current_assets", p), v("current_liabilities", p)),
    debt_to_equity: (p) => div(v("long_term_debt", p) ?? 0, v("equity", p)),
    net_cash: (p) => {
      const cash = v("cash", p);
      return cash == null ? null : cash + (v("short_term_investments", p) ?? 0) - (v("long_term_debt", p) ?? 0);
    },
    shareholder_returns: (p) => {
      const b = v("buybacks", p);
      const d = v("dividends", p);
      return b == null && d == null ? null : (b ?? 0) + (d ?? 0);
    },
  };
  return {
    periods,
    currency,
    metrics: KEY_METRICS.map((m) => ({ ...m, values: periods.map((p) => compute[m.key](p)) })).filter((m) => m.values.some((x) => x !== null)),
  };
}
