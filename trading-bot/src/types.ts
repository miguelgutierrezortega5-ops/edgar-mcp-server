export type AssetClass = "crypto" | "forex";
export type Side = "long" | "short";
export type Timeframe = "5m" | "15m" | "30m" | "1h" | "4h" | "1d";

/** OHLCV bar; `time` is the bar's start in epoch milliseconds. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface StrategyParams {
  fastEma: number;
  slowEma: number;
  trendEma: number;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  atrPeriod: number;
  /** Stop-loss distance in ATRs. */
  stopAtr: number;
  /** Take-profit distance in ATRs; 0 disables it. */
  takeProfitAtr: number;
  /** Trailing-stop distance in ATRs from the best price since entry; 0 disables it. */
  trailingStopAtr: number;
}

export interface Market {
  /** Unique key, e.g. "BTC/USDT 1h". */
  id: string;
  type: AssetClass;
  symbol: string;
  base: string;
  quote: string;
  timeframe: Timeframe;
  allowShort: boolean;
  strategy: StrategyParams;
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
