import type { Candle } from "./types.js";

// Each indicator returns an array aligned with its input; positions without enough history are NaN.
// Values at index i only depend on inputs 0..i, so the same series can drive live trading and backtests.

/** Exponential moving average, seeded with the simple average of the first `period` values. */
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period < 1 || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's relative strength index (0-100). */
export function rsi(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period < 1 || values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  const value = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[period] = value();
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = value();
  }
  return out;
}

/** Wilder's average true range. */
export function atr(candles: Candle[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  if (period < 1 || candles.length <= period) return out;
  const tr = (i: number) => {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  };
  let avg = 0;
  for (let i = 1; i <= period; i++) avg += tr(i);
  avg /= period;
  out[period] = avg;
  for (let i = period + 1; i < candles.length; i++) {
    avg = (avg * (period - 1) + tr(i)) / period;
    out[i] = avg;
  }
  return out;
}
