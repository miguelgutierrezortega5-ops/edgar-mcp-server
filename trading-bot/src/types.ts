export type AssetClass = "crypto" | "forex";
export type Side = "long" | "short";
export type Timeframe = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
export type StrategyName = "cruce_medias" | "capitulacion";

/** OHLCV bar; `time` is the bar's start in epoch milliseconds. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Base volume bought by aggressive (taker) buyers; only some sources (Binance) report it. */
  takerBuy?: number;
}

/** Numeric parameters of a strategy; each strategy documents its own keys. */
export type StrategyParams = Record<string, number>;

export interface Market {
  /** Unique key, e.g. "BTC/USDT 1h". */
  id: string;
  type: AssetClass;
  symbol: string;
  base: string;
  quote: string;
  timeframe: Timeframe;
  allowShort: boolean;
  strategyName: StrategyName;
  strategy: StrategyParams;
  /** Set by the learner when the strategy shows no edge on unseen data: monitored but not traded. */
  paused?: string;
}

export interface Position {
  id: string;
  broker: string;
  marketId: string;
  symbol: string;
  type: AssetClass;
  side: Side;
  units: number;
  entryPrice: number;
  stop: number;
  takeProfit: number | null;
  openedAt: number;
  /** Fees paid on entry, in account currency. */
  entryFee: number;
  /** Best price reached since entry (highest for longs, lowest for shorts); drives the trailing stop. */
  extreme: number;
  /** Broker-side id (OANDA trade id, exchange order id). */
  brokerRef?: string;
  /** Bars starting at or after this time are checked against the current stop (set when the stop moves). */
  watchFrom?: number;
  /** Close the position at this time if neither stop nor target was hit (time stop). */
  expiresAt?: number;
}

export interface ClosedTrade extends Position {
  exitPrice: number;
  closedAt: number;
  /** Net profit or loss in account currency, after all fees. */
  pnl: number;
  /** Total fees (entry + exit) in account currency. */
  fees: number;
  reason: string;
}

/** Latest price of a market and the rate that converts its quote currency into the account currency. */
export interface PriceMark {
  price: number;
  rate: number;
}
