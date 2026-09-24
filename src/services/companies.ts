import { z } from "zod";
import { cached, httpGet } from "./http.js";

export interface Registrant {
  cik: string; // 10-digit, zero padded
  name: string;
  ticker?: string;
  exchange?: string;
}

interface TickerFile {
  fields: string[];
  data: [number, string, string, string][];
}

interface RegistrantIndex {
  all: Registrant[];
  byTicker: Map<string, Registrant>;
  /** Every ticker of a CIK (share classes such as GOOGL/GOOG or BRK-A/BRK-B), in file order. */
  byCik: Map<string, Registrant[]>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const padCik = (cik: string | number) => String(cik).replace(/\D/g, "").padStart(10, "0");

function loadIndex(): Promise<RegistrantIndex> {
  return cached("registrant-index", DAY_MS, async () => {
    const file = await httpGet<TickerFile>("www", "/files/company_tickers_exchange.json");
    const all = file.data.map(([cik, name, ticker, exchange]) => ({ cik: padCik(cik), name, ticker, exchange }));
    const byTicker = new Map<string, Registrant>();
    const byCik = new Map<string, Registrant[]>();
    for (const r of all) {
      if (r.ticker && !byTicker.has(r.ticker)) byTicker.set(r.ticker, r);
      byCik.set(r.cik, [...(byCik.get(r.cik) ?? []), r]);
    }
    return { value: { all, byTicker, byCik }, size: all.length * 100 };
  });
}

export async function loadRegistrants(): Promise<Registrant[]> {
  return (await loadIndex()).all;
}

/** All listed tickers for a CIK (more than one means several share classes). */
export async function tickersForCik(cik: string): Promise<string[]> {
  return ((await loadIndex()).byCik.get(cik) ?? []).map((r) => r.ticker).filter((t): t is string => Boolean(t));
}

export const companyField = z
  .string()
  .min(1)
  .max(100)
  .describe("Company: US ticker ('MSFT', 'BRK.B'), SEC CIK ('789019') or company name ('Microsoft').");

/** Resolve a ticker, CIK or name to an SEC registrant. */
export async function resolveCompany(input: string): Promise<Registrant> {
  const q = input.trim();
  const { all, byTicker, byCik } = await loadIndex();
  if (/^\d{1,10}$/.test(q)) {
    const cik = padCik(q);
    return byCik.get(cik)?.[0] ?? { cik, name: `CIK ${cik}` };
  }
  const byT = byTicker.get(q.toUpperCase().replace(/\./g, "-"));
  if (byT) return byT;
  const lower = q.toLowerCase();
  const byName = all.find((r) => r.name.toLowerCase() === lower) ?? all.find((r) => r.name.toLowerCase().includes(lower));
  if (byName) return byName;
  throw new Error(`No SEC registrant found for '${input}'. Use edgar_search_companies to find the ticker or CIK. (Only companies that file with the SEC are covered.)`);
}
