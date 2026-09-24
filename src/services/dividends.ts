/** Dividend history analytics from Yahoo chart events (split-adjusted amounts). */

export interface Payment {
  date: string;
  amount: number;
}

export interface Split {
  date: string;
  ratio: string;
}

export interface DividendSummary {
  /** Sum of payments in the 365 days to `asOf`. */
  ttm: number;
  ttmYield: number | null;
  /** Payments in the last complete calendar year (≈ payment frequency). */
  paymentsPerYear: number;
  /** Compound annual growth of the yearly total over the last 5 and 10 complete years. */
  cagr5y: number | null;
  cagr10y: number | null;
  /** Consecutive complete years in which the yearly total rose. */
  consecutiveIncreases: number;
  annual: { year: number; total: number; payments: number; partial: boolean }[];
}

const cagr = (to?: number, from?: number, years = 1) => (to && from && from > 0 ? (to / from) ** (1 / years) - 1 : null);

export function summarizeDividends(payments: Payment[], price: number | undefined, asOf: string): DividendSummary {
  const sorted = [...payments].sort((a, b) => a.date.localeCompare(b.date));
  const yearAgo = new Date(Date.parse(asOf) - 365 * 86_400_000).toISOString().slice(0, 10);
  const ttm = sorted.filter((p) => p.date > yearAgo && p.date <= asOf).reduce((s, p) => s + p.amount, 0);

  const currentYear = Number(asOf.slice(0, 4));
  const byYear = new Map<number, { total: number; payments: number }>();
  for (const p of sorted) {
    const y = Number(p.date.slice(0, 4));
    const e = byYear.get(y) ?? { total: 0, payments: 0 };
    e.total += p.amount;
    e.payments += 1;
    byYear.set(y, e);
  }
  const annual = [...byYear.entries()].map(([year, e]) => ({ year, ...e, partial: year >= currentYear })).sort((a, b) => a.year - b.year);
  // The first year of a new dividend is usually partial too (fewer payments than the next year).
  if (annual.length > 1 && !annual[1].partial && annual[0].payments < annual[1].payments) annual[0].partial = true;
  const complete = annual.filter((a) => !a.partial);
  const last = complete.at(-1);
  const total = (y: number) => byYear.get(y)?.total;

  let consecutiveIncreases = 0;
  for (let i = complete.length - 1; i > 0; i--) {
    // Stop at a gap year or a cut.
    if (complete[i].year - complete[i - 1].year !== 1 || complete[i].total <= complete[i - 1].total * 1.0001) break;
    consecutiveIncreases++;
  }

  return {
    ttm,
    ttmYield: price && price > 0 ? ttm / price : null,
    paymentsPerYear: last?.payments ?? 0,
    cagr5y: last ? cagr(last.total, total(last.year - 5), 5) : null,
    cagr10y: last ? cagr(last.total, total(last.year - 10), 10) : null,
    consecutiveIncreases,
    annual,
  };
}
