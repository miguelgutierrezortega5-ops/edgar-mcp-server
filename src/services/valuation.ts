import { STATEMENTS } from "./statements.js";
import { conceptSeries, days, firstAvailable, type CompanyFacts, type PeriodKind, type Point } from "./xbrl.js";

const LINE_DEFS = new Map([...STATEMENTS.income, ...STATEMENTS.balance, ...STATEMENTS.cashflow].map((d) => [d.key, d]));
const byEnd = (a: Point, b: Point) => a.end.localeCompare(b.end);

function lineSeries(facts: CompanyFacts, key: string, kind: PeriodKind): Map<string, Point> {
  const def = LINE_DEFS.get(key);
  if (!def) throw new Error(`Unknown line item '${key}'.`);
  return firstAvailable(facts, def.candidates, kind, def.unit);
}

export interface Trailing {
  value: number;
  through: string;
  /** 'TTM' = sum of the last four consecutive quarters; 'FY' = latest fiscal year. */
  basis: "TTM" | "FY";
  unit: string;
}

/**
 * Trailing-twelve-month value of a flow line item: the sum of the last four quarters when
 * they are consecutive (no missing quarter), else the latest fiscal year. The fiscal year
 * also wins when it ends after the last available quarter (e.g. 20-F filers, which report
 * annually only).
 */
export function trailing(facts: CompanyFacts, key: string): Trailing | null {
  const q = [...lineSeries(facts, key, "quarterly").values()].filter((p) => p.start).sort(byEnd).slice(-4);
  const fy = [...lineSeries(facts, key, "annual").values()].filter((p) => p.start).sort(byEnd).at(-1);
  const consecutive = q.length === 4 && q.every((p, i) => i === 0 || (days(q[i - 1].end, p.end) >= 80 && days(q[i - 1].end, p.end) <= 100));
  if (consecutive && (!fy || q[3].end >= fy.end)) {
    return { value: q.reduce((s, p) => s + p.val, 0), through: q[3].end, basis: "TTM", unit: q[3].unit };
  }
  return fy ? { value: fy.val, through: fy.end, basis: "FY", unit: fy.unit } : null;
}

/** Latest reported value of a line item (balance-sheet instants include 10-Q dates). */
export function latestPoint(facts: CompanyFacts, key: string): Point | undefined {
  return [...lineSeries(facts, key, "quarterly").values()].sort(byEnd).at(-1);
}

export interface ValuationInput {
  facts: CompanyFacts;
  ticker: string;
  price: number;
  priceCurrency?: string;
  /** Every ticker listed under the company's CIK. */
  tickers: string[];
  /** Latest periodic report in the filing index (to detect XBRL lag and foreign filers). */
  latestReport?: { form: string; reportDate?: string; filingDate: string };
}

export interface Valuation {
  company: string;
  ticker: string;
  price: number;
  currency?: string;
  sharesOutstanding: number;
  sharesBasis: string;
  marketCap: number;
  enterpriseValue: number;
  ttmThrough?: string;
  basis: string;
  warnings: string[];
  ttm: { revenue: number | null; netIncome: number | null; ebit: number | null; fcf: number | null };
  balance: { asOf?: string; cashAndShortTermInvestments: number; longTermDebt: number };
  multiples: { pe: number | null; ps: number | null; pFcf: number | null; evRevenue: number | null; evEbit: number | null; earningsYield: number | null; fcfYield: number | null };
}

/** Days after the latest financial period beyond which a cover-page share count is considered stale. */
const SHARES_MAX_AGE_DAYS = 200;

export function computeValuation({ facts, ticker, price, priceCurrency, tickers, latestReport }: ValuationInput): Valuation {
  const name = facts.entityName;
  const revenue = trailing(facts, "revenue");
  const netIncome = trailing(facts, "net_income");
  const ebit = trailing(facts, "operating_income");
  const cfo = trailing(facts, "cfo");
  const capex = trailing(facts, "capex");

  const cashPt = latestPoint(facts, "cash");
  const stiPt = cashPt ? lineSeries(facts, "short_term_investments", "quarterly").get(cashPt.end) : undefined;
  const debtPt = latestPoint(facts, "long_term_debt");

  // Foreign filers often tag some items in their home currency and others (or other years) in
  // USD convenience translations, so check every monetary input, not just revenue.
  const monetary = [revenue, netIncome, ebit, cfo, capex, cashPt, stiPt, debtPt].filter((x): x is Trailing | Point => Boolean(x));
  const otherCurrencies = [...new Set(monetary.map((x) => x.unit).filter((u) => u !== priceCurrency))];
  if (priceCurrency && otherCurrencies.length) {
    throw new Error(
      `${name} reports in ${otherCurrencies.join(", ")} but ${ticker} trades in ${priceCurrency} (typically an ADR, whose shares-per-ADR ratio is not in SEC data), ` +
        "so multiples would mix currencies and share bases. Use edgar_get_key_metrics for fundamentals and market_get_stock_price for the price.",
    );
  }

  const warnings: string[] = [];
  const latestPeriod = [revenue?.through, netIncome?.through].filter((d): d is string => Boolean(d)).sort().at(-1);

  // Cover-page shares outstanding are the best count, but multi-class filers often stop
  // reporting an undimensioned total (Berkshire's last one is from 2011): skip stale counts.
  const current = (p?: Point) => p !== undefined && p.val > 0 && (!latestPeriod || days(latestPeriod, p.end) > -SHARES_MAX_AGE_DAYS);
  const cover = [...conceptSeries(facts, "dei:EntityCommonStockSharesOutstanding", "quarterly", "shares").values()].sort(byEnd).at(-1);
  const diluted = latestPoint(facts, "diluted_shares");
  let shares: number;
  let sharesBasis: string;
  if (current(cover)) {
    shares = cover!.val;
    sharesBasis = `shares outstanding on ${cover!.end} (filing cover page)`;
  } else if (current(diluted)) {
    shares = diluted!.val;
    sharesBasis = `weighted-average diluted shares for the period ending ${diluted!.end}`;
  } else {
    const last = [cover?.end, diluted?.end].filter(Boolean).sort().at(-1);
    throw new Error(
      `No current share count in ${name}'s XBRL data${last ? ` (latest is from ${last})` : ""}, so market cap can't be computed. ` +
        "This is common for companies with several share classes; use edgar_get_key_metrics for fundamentals.",
    );
  }
  if (tickers.length > 1) {
    warnings.push(
      `Several share classes trade under this company (${tickers.join(", ")}). The share count may combine classes or be expressed in one class's equivalents, so check the market cap for ${ticker} against another source.`,
    );
  }
  if (latestReport && /^(20-F|40-F)/.test(latestReport.form)) {
    warnings.push(`${name} is a foreign filer (${latestReport.form}). If ${ticker} is an ADR representing several ordinary shares, the market cap and multiples are off by that ratio.`);
  }
  if (latestPeriod && latestReport?.reportDate && latestReport.reportDate > latestPeriod) {
    warnings.push(
      `The ${latestReport.form} for the period ending ${latestReport.reportDate} (filed ${latestReport.filingDate}) is not yet in the SEC's XBRL dataset, so figures stop at ${latestPeriod}.`,
    );
  }

  // Free cash flow only when both legs cover the same period.
  const fcf = cfo && capex && cfo.through === capex.through && cfo.basis === capex.basis ? cfo.value - capex.value : null;
  const cash = (cashPt?.val ?? 0) + (stiPt?.val ?? 0);
  const debt = debtPt?.val ?? 0;
  const marketCap = price * shares;

  // A price and share count on different bases (share classes such as BRK-A vs BRK-B trade
  // ~1,500× apart) give absurd multiples; refuse rather than report them.
  const equity = latestPoint(facts, "equity")?.val;
  if ((netIncome && netIncome.value > 0 && marketCap / netIncome.value < 1) || (equity && equity > 0 && marketCap / equity < 0.02)) {
    throw new Error(
      `The ${ticker} price (${price}) and ${name}'s reported share count (${sharesBasis}) appear to be on different bases (e.g. share classes or ADRs), ` +
        "so the implied market cap is not meaningful. Use edgar_get_key_metrics for fundamentals and market_get_stock_price for the price.",
    );
  }
  const ev = marketCap + debt - cash;
  const r = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null || b <= 0 ? null : a / b);
  const bases = [...new Set([revenue, netIncome, ebit, cfo].filter(Boolean).map((t) => t!.basis))];

  return {
    company: name,
    ticker,
    price,
    currency: priceCurrency,
    sharesOutstanding: shares,
    sharesBasis,
    marketCap,
    enterpriseValue: ev,
    ttmThrough: latestPeriod,
    basis: bases.length ? bases.map((b) => (b === "TTM" ? "trailing four quarters" : "latest fiscal year")).join(" / ") : "–",
    warnings,
    ttm: { revenue: revenue?.value ?? null, netIncome: netIncome?.value ?? null, ebit: ebit?.value ?? null, fcf },
    balance: { asOf: cashPt?.end, cashAndShortTermInvestments: cash, longTermDebt: debt },
    multiples: {
      pe: r(marketCap, netIncome?.value),
      ps: r(marketCap, revenue?.value),
      pFcf: r(marketCap, fcf),
      evRevenue: r(ev, revenue?.value),
      evEbit: r(ev, ebit?.value),
      earningsYield: r(netIncome?.value, marketCap),
      fcfYield: r(fcf, marketCap),
    },
  };
}
