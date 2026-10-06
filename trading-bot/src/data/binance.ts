import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { httpJson } from "../http.js";
import { TIMEFRAME_MS } from "../timeframes.js";
import type { Candle, Market } from "../types.js";
import type { CandleSource } from "./source.js";

// Binance's public market-data endpoint (no key, reachable worldwide). Unlike ccxt's OHLCV it keeps
// the taker-buy volume of each bar: how much was bought by aggressive market orders, the clearest
// footprint of who is pushing the price.
// Long histories (learning, studies, backtests) are cached on disk: closed bars never change, so
// each later run only downloads the new ones. That matters on a phone's mobile data.
const BASE = process.env.BINANCE_DATA_URL ?? "https://data-api.binance.vision";
/** Requests for fewer bars than this skip the cache (the bot's frequent small refreshes). */
const CACHE_FROM_BARS = 1000;

type Kline = [number, string, string, string, string, string, number, string, number, string, string, string];

export class BinanceSource implements CandleSource {
  readonly name = "binance";
  private readonly memory = new Map<string, Candle[]>();

  constructor(private readonly cacheDir?: string) {}

  private async download(symbol: string, interval: string, step: number, from: number, until = Infinity): Promise<Candle[]> {
    const out: Candle[] = [];
    for (let cursor = from, page = 0; page < 1000 && cursor <= Math.min(until, Date.now()); page++) {
      const rows = await httpJson<Kline[]>(`${BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&limit=1000`);
      for (const k of rows) {
        if (k[0] >= until) break;
        if (out.length && k[0] <= out.at(-1)!.time) continue;
        out.push({ time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], takerBuy: +k[9] });
      }
      if (rows.length < 1000) break;
      cursor = rows.at(-1)![0] + step;
    }
    return out;
  }

  async history(market: Market, since: number): Promise<Candle[]> {
    return this.candles(`${market.base}${market.quote}`, market.timeframe, since);
  }

  /** Candles of any symbol (e.g. BTCUSDT) from `since`; the last one may still be forming. */
  async candles(symbol: string, timeframe: Market["timeframe"], since: number): Promise<Candle[]> {
    const step = TIMEFRAME_MS[timeframe];
    const now = Date.now();
    if (!this.cacheDir || now - since <= CACHE_FROM_BARS * step) return this.download(symbol, timeframe, step, since);

    const key = `${symbol}_${timeframe}`;
    const file = join(this.cacheDir, `${key}.json`);
    let cached = this.memory.get(key) ?? (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Candle[]) : []);
    const before = cached.length;
    if (!cached.length || since < cached[0].time) {
      const head = await this.download(symbol, timeframe, step, since, cached[0]?.time);
      cached = [...head, ...cached];
    }
    const tail = await this.download(symbol, timeframe, step, cached.length ? cached.at(-1)!.time + step : since);
    const all = [...cached, ...tail.filter((c) => !cached.length || c.time > cached.at(-1)!.time)];
    // The forming bar is returned but never cached.
    const closed = all.filter((c) => c.time + step <= now);
    this.memory.set(key, closed);
    if (closed.length !== before) {
      mkdirSync(this.cacheDir, { recursive: true });
      writeFileSync(file, JSON.stringify(closed));
    }
    return all.filter((c) => c.time >= since);
  }
}
