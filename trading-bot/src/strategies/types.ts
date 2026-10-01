import type { Candle, Side, StrategyName, StrategyParams } from "../types.js";

export interface Entry {
  side: Side;
  /** Distances from the fill price, so the stop keeps its size whatever the fill. */
  stopDistance: number;
  takeProfitDistance: number | null;
  /** Close after this many bars if neither stop nor target was hit. */
  maxBars: number | null;
}

/** What a strategy concludes at the close of one bar. */
export interface Signal {
  time: number;
  close: number;
  atr: number;
  entry: Entry | null;
  exitLong: boolean;
  exitShort: boolean;
  reason: string;
  /** Indicator summary for the logs. */
  info: string;
}

/** Data from outside the market itself. */
export interface StrategyContext {
  /** Bars of the reference market (BTC/USDT for crypto), same timeframe. */
  reference?: Candle[];
}

export interface Strategy {
  name: StrategyName;
  description: string;
  defaults: StrategyParams;
  /** Values the learner tries for its tunable parameters (the rest keep their current value). */
  grid: Record<string, number[]>;
  /** Returns an error message for inconsistent parameters. */
  validate(p: StrategyParams): string | null;
  /** Bars needed before the first signal. */
  minCandles(p: StrategyParams): number;
  /** Parameters that `prepare` reads; the prepared series are reused across values of the others. */
  prepareKeys: string[];
  /** Precompute indicator series; values at i may only depend on bars 0..i. */
  prepare(candles: Candle[], p: StrategyParams, ctx?: StrategyContext): unknown;
  /** True when these parameters use the reference market. */
  needsReference?(p: StrategyParams): boolean;
  /** `verbose` false skips the log text (`info`), for bulk evaluation in backtests. */
  evaluate(prep: unknown, i: number, p: StrategyParams, allowShort: boolean, verbose?: boolean): Signal;
}
