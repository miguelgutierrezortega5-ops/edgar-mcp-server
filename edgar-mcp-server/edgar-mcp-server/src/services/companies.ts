import { z } from "zod";
import { httpGet } from "./http.js";

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

const DAY_MS = 24 * 60 * 60 * 1000;

export const padCik = (cik: string | number) => String(cik).replace(/\D/g, "").padStart(10, "0");

export async function loadRegistrants(): Promise<Registrant[]> {
  const file = await httpGet<TickerFile>("www", "/files/company_tickers_exchange.json", { ttl: DAY_MS });
  return file.data.map(([cik, name, ticker, exchange]) => ({ cik: padCik(cik), name, ticker, exchange }));
}

export const companyField = z
  .string()
  .min(1)
  .max(100)
  .describe("Company: US ticker ('MSFT', 'BRK.B'), SEC CIK ('789019') or company name ('Microsoft').");

/** Resolve a ticker, CIK or name to an SEC registrant. */
export async function resolveCompany(input: string): Promise<Registrant> {
  const q = input.trim();
  const all = await loadRegistrants();
  if (/^\d{1,10}$/.test(q)) {
    const cik = padCik(q);
    return all.find((r) => r.cik === cik) ?? { cik, name: `CIK ${cik}` };
  }
  const ticker = q.toUpperCase().replace(/\./g, "-");
  const byTicker = all.find((r) => r.ticker === ticker);
  if (byTicker) return byTicker;
  const lower = q.toLowerCase();
  const byName = all.find((r) => r.name.toLowerCase() === lower) ?? all.find((r) => r.name.toLowerCase().includes(lower));
  if (byName) return byName;
  throw new Error(`No SEC registrant found for '${input}'. Use edgar_search_companies to find the ticker or CIK. (Only companies that file with the SEC are covered.)`);
}
