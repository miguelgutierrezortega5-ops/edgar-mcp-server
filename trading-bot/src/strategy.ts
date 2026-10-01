import { atr, ema, rsi } from "./indicators.js";
import type { Candle, Side, StrategyParams } from "./types.js";

// Trend-following EMA crossover:
// - Long when the fast EMA crosses above the slow EMA, price is above the trend EMA and RSI is not overbought.
// - Short (where allowed) on the mirror image.
// - Exit on the opposite crossover, or earlier at the ATR-based stop-loss / take-profit / trailing stop.

export const DEFAULT_STRATEGY: StrategyParams = {
  fastEma: 20,
  slowEma: 50,
  trendEma: 200,
  rsiPeriod: 14,
  rsiOverbought: 70,
  rsiOversold: 30,
  atrPeriod: 14,
  stopAtr: 2,
  takeProfitAtr: 4,
  trailingStopAtr: 0,
};

export interface Indicators {
  candles: Candle[];
  fast: number[];
  slow: number[];
  trend: number[];
  rsi: number[];
  atr: number[];
}

export interface Snapshot {
  time: number;
  close: number;
  fast: number;
  slow: number;
  trend: number;
  rsi: number;
  atr: number;
}

export interface Entry {
  side: Side;
  /** Distances from the fill price, so the stop keeps its size whatever the fill. */
  stopDistance: number;
  takeProfitDistance: number | null;
}

export interface Signal {
  snapshot: Snapshot;
  exitLong: boolean;
  exitShort: boolean;
  entry: Entry | null;
  reason: string;
}

/** Bars needed before the first signal. */
export function minCandles(p: StrategyParams): number {
  return Math.max(p.fastEma, p.slowEma, p.trendEma, p.rsiPeriod + 1, p.atrPeriod + 1) + 1;
}

export function computeIndicators(candles: Candle[], p: StrategyParams): Indicators {
  const closes = candles.map((c) => c.close);
  return {
    candles,
    fast: ema(closes, p.fastEma),
    slow: ema(closes, p.slowEma),
    trend: ema(closes, p.trendEma),
    rsi: rsi(closes, p.rsiPeriod),
    atr: atr(candles, p.atrPeriod),
  };
}

export function snapshotAt(ind: Indicators, i: number): Snapshot {
  return { time: ind.candles[i].time, close: ind.candles[i].close, fast: ind.fast[i], slow: ind.slow[i], trend: ind.trend[i], rsi: ind.rsi[i], atr: ind.atr[i] };
}

/** Evaluate the strategy at the close of bar `i`. */
export function evaluate(ind: Indicators, i: number, p: StrategyParams, allowShort: boolean): Signal {
  const s = snapshotAt(ind, i);
  const prevFast = ind.fast[i - 1];
  const prevSlow = ind.slow[i - 1];
  const ready = i >= 1 && [s.fast, s.slow, s.trend, s.rsi, s.atr, prevFast, prevSlow].every(Number.isFinite);
  if (!ready) return { snapshot: s, exitLong: false, exitShort: false, entry: null, reason: "historial insuficiente" };

  const crossUp = prevFast <= prevSlow && s.fast > s.slow;
  const crossDown = prevFast >= prevSlow && s.fast < s.slow;
  const stopDistance = p.stopAtr * s.atr;
  const takeProfitDistance = p.takeProfitAtr > 0 ? p.takeProfitAtr * s.atr : null;

  let entry: Entry | null = null;
  let reason = s.fast > s.slow ? "EMA rápida por encima de la lenta" : "EMA rápida por debajo de la lenta";
  if (crossUp) {
    if (s.close <= s.trend) reason = "cruce alcista contra la tendencia (precio bajo la EMA de tendencia)";
    else if (s.rsi >= p.rsiOverbought) reason = `cruce alcista con RSI sobrecomprado (${s.rsi.toFixed(1)})`;
    else {
      entry = { side: "long", stopDistance, takeProfitDistance };
      reason = "cruce alcista a favor de la tendencia";
    }
  } else if (crossDown) {
    if (!allowShort) reason = "cruce bajista (cortos desactivados)";
    else if (s.close >= s.trend) reason = "cruce bajista contra la tendencia (precio sobre la EMA de tendencia)";
    else if (s.rsi <= p.rsiOversold) reason = `cruce bajista con RSI sobrevendido (${s.rsi.toFixed(1)})`;
    else {
      entry = { side: "short", stopDistance, takeProfitDistance };
      reason = "cruce bajista a favor de la tendencia";
    }
  }
  if (!(stopDistance > 0)) entry = null;
  return { snapshot: s, exitLong: crossDown, exitShort: crossUp, entry, reason };
}
