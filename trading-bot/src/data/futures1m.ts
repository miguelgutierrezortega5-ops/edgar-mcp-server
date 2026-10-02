import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError, httpJson } from "../http.js";
import type { Bar } from "../mechas/core.js";
import { firstZipEntry } from "./zip.js";

// 1-minute candles of Binance USDⓈ-M perpetuals for the wick hunter, plus what the coin selection needs.
// Live: fapi.binance.com (works from Mexico). Where it refuses the country (the US, HTTP 451), the
// spot market API stands in: same prices within a hair for coins listed on both, so the simulation
// still runs, but perpetual-only coins drop out. History for backtests: data.binance.vision daily
// zips, cached on disk (a past day never changes).

const FAPI = process.env.BINANCE_FUTURES_URL ?? "https://fapi.binance.com";
const SPOT = process.env.BINANCE_DATA_URL ?? "https://data-api.binance.vision";
const ARCHIVE = process.env.BINANCE_ARCHIVE_URL ?? "https://data.binance.vision";
const MINUTE = 60_000;
const DAY = 86_400_000;

type Kline = [number, string, string, string, string, ...unknown[]];
const toBar = (k: Kline): Bar => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4] });

export interface CoinInfo {
  symbol: string;
  quoteVolume: number;
  /** Price step as a fraction of the price (0 when unknown). */
  tick: number;
  /** False for perpetuals on stocks, indexes or commodities. */
  crypto: boolean;
}

export interface MinuteSource {
  /** Closed 1-minute bars from `since` (inclusive), oldest first. */
  minutes(symbol: string, since: number, now: number): Promise<Bar[]>;
  /** Perpetuals with their 24 h volume and tick. */
  coins(): Promise<CoinInfo[]>;
  /** Daily bars (for the volatility ranking), oldest first. */
  days(symbol: string, count: number): Promise<Bar[]>;
}

export class FuturesMinutes implements MinuteSource {
  /** False once fapi.binance.com refused this country: use spot prices instead, in every instance. */
  private static liveOk = true;

  constructor(
    private readonly cacheDir?: string,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  get usingFutures(): boolean {
    return FuturesMinutes.liveOk;
  }

  private async get<T>(path: string, spotPath: string): Promise<T> {
    if (FuturesMinutes.liveOk) {
      try {
        return await httpJson<T>(`${FAPI}${path}`);
      } catch (err) {
        if (!(err instanceof HttpError) || (err.status !== 451 && err.status !== 403)) throw err;
        FuturesMinutes.liveOk = false;
        this.log("Aviso: Binance futuros no responde desde este país (HTTP 451); el reto 2 usa precios del mercado spot");
      }
    }
    return httpJson<T>(`${SPOT}${spotPath}`);
  }

  async minutes(symbol: string, since: number, now: number): Promise<Bar[]> {
    const out: Bar[] = [];
    let from = since;
    while (from < now - MINUTE) {
      const q = `symbol=${symbol}&interval=1m&startTime=${from}&limit=1000`;
      const rows = await this.get<Kline[]>(`/fapi/v1/klines?${q}`, `/api/v3/klines?${q}`);
      const bars = rows.map(toBar).filter((b) => b.time + MINUTE <= now);
      out.push(...bars);
      if (rows.length < 1000 || !bars.length) break;
      from = bars[bars.length - 1].time + MINUTE;
    }
    return out;
  }

  async coins(): Promise<CoinInfo[]> {
    type Filter = { filterType: string; tickSize?: string };
    type Info = { symbols: { symbol: string; status: string; quoteAsset: string; contractType?: string; underlyingType?: string; filters: Filter[] }[] };
    const info = await this.get<Info>("/fapi/v1/exchangeInfo", "/api/v3/exchangeInfo?permissions=SPOT");
    const tickers = await this.get<{ symbol: string; quoteVolume: string; lastPrice: string }[]>("/fapi/v1/ticker/24hr", "/api/v3/ticker/24hr?type=MINI");
    const byTicker = new Map(tickers.map((t) => [t.symbol, t]));
    const out: CoinInfo[] = [];
    for (const s of info.symbols) {
      if (s.status !== "TRADING" || s.quoteAsset !== "USDT" || (s.contractType && s.contractType !== "PERPETUAL")) continue;
      const t = byTicker.get(s.symbol);
      if (!t) continue;
      const tickSize = Number(s.filters.find((f) => f.filterType === "PRICE_FILTER")?.tickSize ?? 0);
      const price = Number(t.lastPrice);
      out.push({ symbol: s.symbol, quoteVolume: Number(t.quoteVolume), tick: price > 0 ? tickSize / price : 0, crypto: !s.underlyingType || s.underlyingType === "COIN" });
    }
    return out;
  }

  async days(symbol: string, count: number): Promise<Bar[]> {
    const q = `symbol=${symbol}&interval=1d&limit=${count}`;
    return (await this.get<Kline[]>(`/fapi/v1/klines?${q}`, `/api/v3/klines?${q}`)).map(toBar);
  }

  /** One UTC day of 1-minute bars from the futures archive (empty if Binance has not published it). */
  async archiveDay(symbol: string, dayStart: number): Promise<Bar[]> {
    const date = new Date(dayStart).toISOString().slice(0, 10);
    const file = this.cacheDir && join(this.cacheDir, `${symbol}-${date}.json`);
    if (file && existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Bar[];
    const res = await fetch(`${ARCHIVE}/data/futures/um/daily/klines/${symbol}/1m/${symbol}-1m-${date}.zip`, { signal: AbortSignal.timeout(60_000) });
    if (res.status === 404) return [];
    if (!res.ok) throw new HttpError(res.status, res.url, await res.text());
    const bars = firstZipEntry(Buffer.from(await res.arrayBuffer()))
      .toString()
      .split(/\r?\n/)
      .filter((l) => /^\d/.test(l))
      .map((l) => toBar(l.split(",") as unknown as Kline))
      .filter((b) => Number.isFinite(b.close));
    if (file && bars.length) {
      mkdirSync(this.cacheDir!, { recursive: true });
      writeFileSync(file, JSON.stringify(bars));
    }
    return bars;
  }

  /** Archive days [from, to) for backtests, oldest first. */
  async archive(symbol: string, from: number, to: number): Promise<Bar[]> {
    const out: Bar[] = [];
    for (let d = Math.floor(from / DAY) * DAY; d < to; d += DAY) out.push(...(await this.archiveDay(symbol, d)));
    return out.filter((b) => b.time >= from && b.time < to);
  }
}

/** For tests. */
export function resetFuturesMinutes(): void {
  (FuturesMinutes as unknown as { liveOk: boolean }).liveOk = true;
}
