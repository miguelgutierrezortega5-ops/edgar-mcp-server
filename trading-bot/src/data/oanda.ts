import { httpJson } from "../http.js";
import { TIMEFRAME_MS } from "../timeframes.js";
import type { Candle, Market, Timeframe } from "../types.js";
import type { CandleSource } from "./source.js";

export type OandaEnv = "practice" | "live";

const GRANULARITY: Partial<Record<Timeframe, string>> = { "1m": "M1", "5m": "M5", "15m": "M15", "30m": "M30", "1h": "H1", "4h": "H4", "1d": "D" };

export function oandaInstrument(market: Pick<Market, "base" | "quote">): string {
  return `${market.base}_${market.quote}`;
}

export class OandaClient {
  readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    readonly accountId: string,
    readonly env: OandaEnv,
  ) {
    this.baseUrl = process.env.OANDA_BASE_URL ?? (env === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com");
  }

  request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    return httpJson<T>(this.baseUrl + path, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", "Accept-Datetime-Format": "UNIX" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  account(path = ""): string {
    return `/v3/accounts/${encodeURIComponent(this.accountId)}${path}`;
  }
}

interface CandlesResponse {
  candles: { time: string; volume: number; complete: boolean; mid: { o: string; h: string; l: string; c: string } }[];
}

export class OandaSource implements CandleSource {
  readonly name = "oanda";

  constructor(private readonly client: OandaClient) {}

  async history(market: Market, since: number): Promise<Candle[]> {
    const step = TIMEFRAME_MS[market.timeframe];
    const granularity = GRANULARITY[market.timeframe];
    if (!granularity) throw new Error(`OANDA no ofrece velas de ${market.timeframe}`);
    const out: Candle[] = [];
    let cursor = since;
    for (let page = 0; page < 100 && cursor <= Date.now(); page++) {
      const query = `price=M&granularity=${granularity}&from=${Math.floor(cursor / 1000)}&count=5000`;
      const res = await this.client.request<CandlesResponse>(`/v3/instruments/${oandaInstrument(market)}/candles?${query}`);
      const last = out.at(-1)?.time ?? -Infinity;
      const fresh = res.candles
        .map((c) => ({ time: Math.round(Number(c.time) * 1000), open: Number(c.mid.o), high: Number(c.mid.h), low: Number(c.mid.l), close: Number(c.mid.c), volume: c.volume }))
        .filter((c) => c.time > last);
      out.push(...fresh);
      if (res.candles.length < 5000 || !fresh.length) break;
      cursor = fresh.at(-1)!.time + step;
    }
    return out;
  }
}
