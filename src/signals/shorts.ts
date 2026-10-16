/**
 * Short positioning: exchange-reported short interest (twice a month, via Nasdaq) and FINRA's daily
 * short-sale volume files. Daily short volume includes market-maker hedging, so ~40–50% is normal;
 * read it as a change against the stock's own recent average, not as an absolute bearish share.
 */
import { HttpError, httpGet } from "../services/http.js";
import { parseNum } from "./stats.js";

export interface ShortInterestRow {
  settlement: string;
  shares: number | null;
  avgDailyVolume: number | null;
  daysToCover: number | null;
}

export async function getShortInterest(symbol: string): Promise<ShortInterestRow[]> {
  const res = await httpGet<{ data: { shortInterestTable?: { rows?: { settlementDate: string; interest: string; avgDailyShareVolume: string; daysToCover: unknown }[] } } | null }>(
    "nasdaq",
    `/api/quote/${encodeURIComponent(symbol.toUpperCase())}/short-interest?assetClass=stocks`,
    { ttl: 6 * 3600 * 1000 },
  );
  return (res.data?.shortInterestTable?.rows ?? []).map((r) => ({
    settlement: r.settlementDate,
    shares: parseNum(r.interest),
    avgDailyVolume: parseNum(r.avgDailyShareVolume),
    daysToCover: parseNum(r.daysToCover),
  }));
}

export interface ShortVolumeDay {
  date: string;
  shortVolume: number;
  totalVolume: number;
  ratio: number;
}

/** Parse one FINRA consolidated daily file ("Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market"). */
export function parseShortVolume(text: string, symbol: string): ShortVolumeDay | null {
  const want = symbol.toUpperCase();
  for (const line of text.split("\n")) {
    const f = line.split("|");
    if (f[1] === want) {
      const sv = Number(f[2]);
      const tv = Number(f[4]);
      return { date: `${f[0].slice(0, 4)}-${f[0].slice(4, 6)}-${f[0].slice(6, 8)}`, shortVolume: sv, totalVolume: tv, ratio: tv > 0 ? sv / tv : NaN };
    }
  }
  return null;
}

/** Last `days` weekdays of FINRA short volume for one symbol (holidays are skipped). */
export async function getShortVolume(symbol: string, days: number, now = new Date()): Promise<ShortVolumeDay[]> {
  const dates: string[] = [];
  for (let d = new Date(now); dates.length < days + 4 && dates.length < 40; d.setUTCDate(d.getUTCDate() - 1)) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) dates.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
  }
  const results = await Promise.all(
    dates.map(async (ymd) => {
      try {
        const text = await httpGet<string>("finra", `/equity/regsho/daily/CNMSshvol${ymd}.txt`, { as: "text", ttl: 12 * 3600 * 1000 });
        return parseShortVolume(text, symbol);
      } catch (e) {
        if (e instanceof HttpError && (e.status === 403 || e.status === 404)) return null; // not published (holiday / today)
        throw e;
      }
    }),
  );
  return results.filter((r): r is ShortVolumeDay => r !== null).slice(0, days);
}
