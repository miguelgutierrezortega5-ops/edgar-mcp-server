import { atr, ema, rsi } from "../indicators.js";
import type { Candle, StrategyParams } from "../types.js";
import type { Signal, Strategy } from "./types.js";

// Trend-following EMA crossover:
// - Long when the fast EMA crosses above the slow EMA, price is above the trend EMA and RSI is not overbought.
// - Short (where allowed) on the mirror image.
// - Exit on the opposite crossover, or earlier at the ATR-based stop-loss / take-profit / trailing stop.

export interface Indicators {
  candles: Candle[];
  fast: number[];
  slow: number[];
  trend: number[];
  rsi: number[];
  atr: number[];
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

export function evaluateEma(ind: Indicators, i: number, p: StrategyParams, allowShort: boolean, verbose = true): Signal {
  const c = ind.candles[i];
  const [fast, slow, trend, r, a] = [ind.fast[i], ind.slow[i], ind.trend[i], ind.rsi[i], ind.atr[i]];
  const prevFast = ind.fast[i - 1];
  const prevSlow = ind.slow[i - 1];
  const base = { time: c.time, close: c.close, atr: a, exitLong: false, exitShort: false, entry: null };
  const ready = i >= 1 && [fast, slow, trend, r, a, prevFast, prevSlow].every(Number.isFinite);
  if (!ready) return { ...base, reason: "historial insuficiente", info: "" };

  const info = !verbose ? "" : `tendencia ${c.close > trend ? "alcista" : "bajista"} | EMA${p.fastEma} ${fast > slow ? ">" : "<"} EMA${p.slowEma} | RSI ${r.toFixed(1)}`;
  const crossUp = prevFast <= prevSlow && fast > slow;
  const crossDown = prevFast >= prevSlow && fast < slow;
  const stopDistance = p.stopAtr * a;
  const takeProfitDistance = p.takeProfitAtr > 0 ? p.takeProfitAtr * a : null;

  let entry: Signal["entry"] = null;
  let reason = fast > slow ? "EMA rápida por encima de la lenta" : "EMA rápida por debajo de la lenta";
  if (crossUp) {
    if (c.close <= trend) reason = "cruce alcista contra la tendencia (precio bajo la EMA de tendencia)";
    else if (r >= p.rsiOverbought) reason = `cruce alcista con RSI sobrecomprado (${r.toFixed(1)})`;
    else {
      entry = { side: "long", stopDistance, takeProfitDistance, maxBars: null };
      reason = "cruce alcista a favor de la tendencia";
    }
  } else if (crossDown) {
    if (!allowShort) reason = "cruce bajista (cortos desactivados)";
    else if (c.close >= trend) reason = "cruce bajista contra la tendencia (precio sobre la EMA de tendencia)";
    else if (r <= p.rsiOversold) reason = `cruce bajista con RSI sobrevendido (${r.toFixed(1)})`;
    else {
      entry = { side: "short", stopDistance, takeProfitDistance, maxBars: null };
      reason = "cruce bajista a favor de la tendencia";
    }
  }
  if (!(stopDistance > 0)) entry = null;
  return { ...base, exitLong: crossDown, exitShort: crossUp, entry, reason, info };
}

export const emaCross: Strategy = {
  name: "cruce_medias",
  description: "cruce de medias exponenciales con filtro de tendencia y RSI",
  defaults: {
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
  },
  grid: { fastEma: [10, 20], slowEma: [30, 50, 100], trendEma: [100, 200], stopAtr: [1.5, 2, 3], takeProfitAtr: [0, 3, 5] },
  validate: (p) => (p.fastEma >= p.slowEma ? "fastEma debe ser menor que slowEma" : p.rsiOversold >= p.rsiOverbought ? "rsiOversold debe ser menor que rsiOverbought" : null),
  minCandles: (p) => Math.max(p.fastEma, p.slowEma, p.trendEma, p.rsiPeriod + 1, p.atrPeriod + 1) + 1,
  prepareKeys: ["fastEma", "slowEma", "trendEma", "rsiPeriod", "atrPeriod"],
  prepare: computeIndicators,
  evaluate: (prep, i, p, allowShort, verbose) => evaluateEma(prep as Indicators, i, p, allowShort, verbose),
};
