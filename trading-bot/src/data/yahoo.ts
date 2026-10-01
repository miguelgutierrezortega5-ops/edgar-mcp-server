import { httpJson } from "../http.js";
import { aggregate, TIMEFRAME_MS } from "../timeframes.js";
import type { Candle, Market, Timeframe } from "../types.js";
import type { CandleSource, FxRates } from "./source.js";

// Yahoo Finance's public chart endpoint: free and keyless, but unofficial and for personal use only.
const BASE = process.env.YAHOO_BASE_URL ?? "https://query1.finance.yahoo.com";
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; trading-bot)" };
const DAY = 86_400_000;

/** Yahoo interval and how far back it serves it. */
const INTERVALS: Partial<Record<Timeframe, { interval: string; maxDays: number }>> = {
  "1m": { interval: "1m", maxDays: 7 },
  "5m": { interval: "5m", maxDays: 59 },
  "15m": { interval: "15m", maxDays: 59 },
  "30m": { interval: "30m", maxDays: 59 },
  "1h": { interval: "60m", maxDays: 729 },
  "4h": { interval: "60m", maxDays: 729 },
  "1d": { interval: "1d", maxDays: 365 * 30 },
};

interface Chart {
  chart: {
    result:
      | {
          meta: { regularMarketPrice?: number };
          timestamp?: number[];
          indicators: { quote: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[] }[] };
        }[]
      | null;
    error?: { description?: string } | null;
  };
}

export function yahooSymbol(base: string, quote: string): string {
  return `${base}${quote}=X`;
}

async function chart(symbol: string, query: string) {
  const res = await httpJson<Chart>(`${BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`, { headers: HEADERS });
  const result = res.chart.result?.[0];
  if (!result) throw new Error(`Yahoo no tiene datos de ${symbol}: ${res.chart.error?.description ?? "símbolo desconocido"}`);
  return result;
}

/** Parse Yahoo's parallel arrays into bars aligned to the timeframe. */
export function parseChart(result: NonNullable<Chart["chart"]["result"]>[number], tf: Timeframe): Candle[] {
  const q = result.indicators.quote[0];
  const raw: Candle[] = [];
  (result.timestamp ?? []).forEach((t, i) => {
    const [open, high, low, close] = [q.open[i], q.high[i], q.low[i], q.close[i]];
    if ([open, high, low, close].every((v) => typeof v === "number" && Number.isFinite(v))) {
      // Daily FX bars start at 22:00-00:00 UTC (the London close); shift them onto the UTC date they trade.
      const time = tf === "1d" ? t * 1000 + 2 * 3_600_000 : t * 1000;
      raw.push({ time, open: open!, high: high!, low: low!, close: close!, volume: 0 });
    }
  });
  // Yahoo appends a last-trade snapshot at the current time; bucketing folds it into the forming bar.
  return aggregate(raw, TIMEFRAME_MS[tf]);
}

export class YahooFxSource implements CandleSource, FxRates {
  readonly name = "yahoo";
  private readonly rates = new Map<string, { value: number; expires: number }>();

  async history(market: Market, since: number): Promise<Candle[]> {
    const spec = INTERVALS[market.timeframe];
    if (!spec) throw new Error(`Yahoo no ofrece velas de ${market.timeframe}`);
    const { interval, maxDays } = spec;
    const now = Date.now();
    const from = Math.max(since, now - maxDays * DAY);
    const result = await chart(yahooSymbol(market.base, market.quote), `period1=${Math.floor(from / 1000)}&period2=${Math.floor(now / 1000)}&interval=${interval}`);
    return parseChart(result, market.timeframe).filter((c) => c.time >= since - TIMEFRAME_MS[market.timeframe]);
  }

  async rate(from: string, to: string): Promise<number> {
    if (from === to) return 1;
    const key = `${from}${to}`;
    const hit = this.rates.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const result = await chart(yahooSymbol(from, to), "range=1d&interval=1d");
    const value = result.meta.regularMarketPrice;
    if (!(typeof value === "number" && value > 0)) throw new Error(`Sin tipo de cambio ${from}/${to}`);
    this.rates.set(key, { value, expires: Date.now() + 10 * 60_000 });
    return value;
  }
}
