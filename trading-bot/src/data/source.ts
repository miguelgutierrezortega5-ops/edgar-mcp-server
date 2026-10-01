import type { Candle, Market } from "../types.js";

export interface CandleSource {
  readonly name: string;
  /** Bars from `since` (epoch ms) to now, oldest first. The last bar may still be forming. */
  history(market: Market, since: number): Promise<Candle[]>;
}

/** Stablecoins treated as their fiat currency when converting to the account currency. */
const PEGGED: Record<string, string> = { USDT: "USD", USDC: "USD", DAI: "USD", FDUSD: "USD", TUSD: "USD", USDP: "USD", PYUSD: "USD", EURC: "EUR" };

export function fiatOf(currency: string): string {
  return PEGGED[currency] ?? currency;
}

export interface FxRates {
  /** Units of `to` per unit of `from`. */
  rate(from: string, to: string): Promise<number>;
}

/**
 * Rate that converts an amount in `market`'s quote currency into the account currency,
 * given the market's current price.
 */
export async function quoteRate(market: Market, price: number, account: string, fx: FxRates): Promise<number> {
  const quote = fiatOf(market.quote);
  if (quote === account) return 1;
  if (fiatOf(market.base) === account) return 1 / price;
  return fx.rate(quote, account);
}

/** Synchronous quote-to-account rate for backtests: exact for X/account and account/X pairs, fixed for crosses. */
export async function rateFunction(market: Market, account: string, fx: FxRates, refPrice: number): Promise<(price: number) => number> {
  if (fiatOf(market.quote) === account) return () => 1;
  if (fiatOf(market.base) === account) return (p) => 1 / p;
  const r = await quoteRate(market, refPrice, account, fx);
  return () => r;
}
