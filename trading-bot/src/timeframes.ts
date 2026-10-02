import type { Candle, Timeframe } from "./types.js";

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 3_600_000,
  "4h": 4 * 3_600_000,
  "1d": 86_400_000,
};

export const TIMEFRAMES = Object.keys(TIMEFRAME_MS) as Timeframe[];

/** Bars whose period has fully elapsed; the last bar a feed returns is usually still forming. */
export function closedCandles(candles: Candle[], tf: Timeframe, now: number): Candle[] {
  const ms = TIMEFRAME_MS[tf];
  let end = candles.length;
  while (end > 0 && candles[end - 1].time + ms > now) end--;
  return end === candles.length ? candles : candles.slice(0, end);
}

/** Merge `fresh` into `existing` (both sorted by time); bars with the same start are replaced. */
export function mergeCandles(existing: Candle[], fresh: Candle[], max: number): Candle[] {
  if (!fresh.length) return existing.slice(-max);
  const cut = fresh[0].time;
  const merged = existing.filter((c) => c.time < cut).concat(fresh);
  return merged.slice(-max);
}

/** Group bars into larger buckets aligned to UTC (e.g. 1h → 4h). */
export function aggregate(candles: Candle[], bucketMs: number): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const t = Math.floor(c.time / bucketMs) * bucketMs;
    const last = out.at(-1);
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else {
      out.push({ ...c, time: t });
    }
  }
  return out;
}
