import ccxt, { type Exchange } from "ccxt";
import { TIMEFRAME_MS } from "../timeframes.js";
import type { Candle, Market } from "../types.js";
import type { CandleSource } from "./source.js";

export interface ExchangeCredentials {
  apiKey?: string;
  secret?: string;
  password?: string;
}

export function createExchange(id: string, creds: ExchangeCredentials = {}, sandbox = false): Exchange {
  const Ctor = (ccxt as unknown as Record<string, new (config: object) => Exchange>)[id];
  if (typeof Ctor !== "function" || !(ccxt.exchanges as string[]).includes(id)) {
    throw new Error(`Exchange '${id}' desconocido. Usa un id de ccxt: binance, kraken, coinbase, bitget, bybit, okx…`);
  }
  const ex = new Ctor({ enableRateLimit: true, ...creds, options: { defaultType: "spot" } });
  if (sandbox) {
    try {
      ex.setSandboxMode(true);
    } catch {
      throw new Error(`'${id}' no tiene entorno de pruebas (sandbox/testnet) en ccxt. Usa broker "paper" o pon sandbox: false si quieres operar con dinero real.`);
    }
  }
  return ex;
}

export class CcxtSource implements CandleSource {
  readonly name: string;

  constructor(private readonly ex: Exchange) {
    this.name = ex.id;
  }

  async history(market: Market, since: number): Promise<Candle[]> {
    if (this.ex.timeframes && !(market.timeframe in this.ex.timeframes)) {
      throw new Error(`${this.ex.id} no ofrece velas de ${market.timeframe}`);
    }
    const step = TIMEFRAME_MS[market.timeframe];
    const limit = (this.ex.features as { spot?: { fetchOHLCV?: { limit?: number } } } | undefined)?.spot?.fetchOHLCV?.limit ?? 1000;
    const out: Candle[] = [];
    let cursor = since;
    // Exchanges cap each request (Binance 1000, Coinbase 300, Kraken only serves its last 720 bars), so page by time.
    for (let page = 0; page < 500; page++) {
      const rows = await this.ex.fetchOHLCV(market.symbol, market.timeframe, cursor, limit);
      const last = out.at(-1)?.time ?? -Infinity;
      const fresh = rows
        .filter((r) => [r[0], r[1], r[2], r[3], r[4]].every((v) => typeof v === "number" && Number.isFinite(v)) && (r[0] as number) > last)
        .map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume: volume ?? 0 }) as Candle);
      if (!fresh.length) break;
      out.push(...fresh);
      cursor = fresh.at(-1)!.time + step;
      if (cursor > Date.now()) break;
    }
    return out;
  }
}
