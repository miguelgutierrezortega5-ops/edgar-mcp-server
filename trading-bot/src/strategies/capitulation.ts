import { atr } from "../indicators.js";
import type { Candle, StrategyParams } from "../types.js";
import type { Signal, Strategy, StrategyContext } from "./types.js";

// Capitulation reversal ("buy the whale's flush"). In thin crypto markets a sharp drop on abnormal
// volume is usually a stop hunt or a liquidation cascade, not news: once the stops below the recent
// lows are taken, price tends to snap back. Measured on 16 Binance pairs with $1-8M daily volume, 3m
// bars: after a -3% move in 30 minutes on 4x volume, price was higher an hour later 64-80% of the
// time. The stop goes well below the flush low (tight stops are exactly what gets hunted), the
// target is a retrace of the drop, and the trade is abandoned after `maxBars`.
// Which flushes bounce depends on the whole market: a coin crashing on its own (BTC calm) tends to
// keep falling (real selling: news, unlocks, a whale exiting), while flushes during a BTC drop are
// liquidation cascades that overshoot and snap back. Over 150 days, 16 pairs: isolated flushes PF
// 0.73-0.82, flushes with BTC down >= 0.5% PF 1.68-3.29. `marketDropPct` keeps only the latter.
// The mirror image (fading a pump) is only used where shorting is allowed.

interface Prepared {
  candles: Candle[];
  relVolume: number[];
  atr: number[];
  /** % move of the reference market over the same `lookback` bars (NaN if unknown). */
  marketMove: number[];
}

/** % move of `reference` between the times of bars i - lookback and i of `candles`. */
export function referenceMove(candles: Candle[], reference: Candle[] | undefined, lookback: number): number[] {
  const closes = new Map((reference ?? []).map((c) => [c.time, c.close]));
  return candles.map((c, i) => {
    const a = i >= lookback ? closes.get(candles[i - lookback].time) : undefined;
    const b = closes.get(c.time);
    return a && b ? (b / a - 1) * 100 : NaN;
  });
}

/** Volume of each bar relative to the average of the `period` bars before it. */
export function relativeVolume(candles: Candle[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i >= period) {
      out[i] = sum > 0 ? candles[i].volume / (sum / period) : NaN;
      sum -= candles[i - period].volume;
    }
    sum += candles[i].volume;
  }
  return out;
}

function prepare(candles: Candle[], p: StrategyParams, ctx?: StrategyContext): Prepared {
  return { candles, relVolume: relativeVolume(candles, p.volumeAvg), atr: atr(candles, p.atrPeriod), marketMove: referenceMove(candles, ctx?.reference, p.lookback) };
}

function evaluate(prep: unknown, i: number, p: StrategyParams, allowShort: boolean, verbose = true): Signal {
  const { candles, relVolume, atr: atrs, marketMove } = prep as Prepared;
  const c = candles[i];
  const a = atrs[i];
  const rv = relVolume[i];
  const base = { time: c.time, close: c.close, atr: a, entry: null, exitLong: false, exitShort: false };
  if (i < p.lookback || !Number.isFinite(rv) || !Number.isFinite(a)) return { ...base, reason: "historial insuficiente", info: "" };

  const from = candles[i - p.lookback];
  const move = (c.close / from.close - 1) * 100;
  const mm = marketMove[i];
  const info = !verbose ? "" : `${move >= 0 ? "+" : ""}${move.toFixed(2)}% en ${p.lookback} velas | volumen ×${rv.toFixed(1)}${Number.isFinite(mm) ? ` | mercado ${mm >= 0 ? "+" : ""}${mm.toFixed(2)}%` : ""}`;
  const window = () => candles.slice(i - p.lookback, i + 1);
  const loud = rv >= p.relVolume;

  if (move <= -p.dropPct && loud) {
    if (p.marketDropPct > 0 && !(mm <= -p.marketDropPct)) {
      return { ...base, info, reason: `desplome aislado de ${move.toFixed(1)}% (el mercado no cae ${p.marketDropPct}%): suele seguir cayendo, no se compra` };
    }
    const stop = Math.min(...window().map((b) => b.low)) - p.stopAtr * a;
    return {
      ...base,
      info,
      reason: `desplome de ${move.toFixed(1)}% con volumen ×${rv.toFixed(1)}${p.marketDropPct > 0 ? " en una cascada del mercado" : ""}: compra el rebote`,
      entry: { side: "long", stopDistance: c.close - stop, takeProfitDistance: p.retrace > 0 ? p.retrace * (from.close - c.close) : null, maxBars: p.maxBars },
    };
  }
  if (move >= p.dropPct && loud) {
    if (p.marketDropPct > 0 && !(mm >= p.marketDropPct)) return { ...base, info, reason: `bombeo aislado de +${move.toFixed(1)}%: no se opera` };
    if (!allowShort) return { ...base, info, reason: `bombeo de +${move.toFixed(1)}% con volumen ×${rv.toFixed(1)}: no se compra (suele deshacerse)` };
    const stop = Math.max(...window().map((b) => b.high)) + p.stopAtr * a;
    return {
      ...base,
      info,
      reason: `bombeo de +${move.toFixed(1)}% con volumen ×${rv.toFixed(1)}: corto a favor de la reversión`,
      entry: { side: "short", stopDistance: stop - c.close, takeProfitDistance: p.retrace > 0 ? p.retrace * (c.close - from.close) : null, maxBars: p.maxBars },
    };
  }
  return { ...base, info, reason: "sin capitulación" };
}

export const capitulation: Strategy = {
  name: "capitulacion",
  description: "compra desplomes bruscos con volumen anómalo (barridas de stops de las ballenas) y vende el rebote",
  defaults: { lookback: 10, dropPct: 3, relVolume: 4, volumeAvg: 50, atrPeriod: 14, stopAtr: 1.5, retrace: 1, maxBars: 40, marketDropPct: 0.5 },
  grid: { dropPct: [2, 3, 4], relVolume: [3, 4], stopAtr: [1, 1.5, 2.5], retrace: [0.5, 1], maxBars: [40, 120], marketDropPct: [0, 0.5, 1] },
  needsReference: (p) => p.marketDropPct > 0,
  validate: (p) => (p.lookback < 1 || p.volumeAvg < 5 ? "lookback y volumeAvg deben ser positivos" : null),
  minCandles: (p) => Math.max(p.lookback, p.volumeAvg, p.atrPeriod + 1) + 1,
  prepareKeys: ["volumeAvg", "atrPeriod", "lookback"],
  prepare,
  evaluate,
};
