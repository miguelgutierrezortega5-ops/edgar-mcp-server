import type { Candle } from "../types.js";

// Challenge 1's hourly trade (asked by the user on 2026-10-11: "one trade every hour, no matter what, on the
// option most likely to win"). For each coin, the probability that the next hour's move beats the round-trip
// cost, from a logistic regression on 13 readings of the closed hourly candles, trained on the last 90 days.
// Measured walk-forward (Jul 2024 - Oct 2026, the 12 coins of challenge 1): the chosen coin won after costs
// 36.9% of the hours vs 33.1% for a random one, but none of them reached 50% and its mean move was ~0, so
// every trade loses about its cost (-0.31%). The study is in the research notes.

export const HOUR = 3_600_000;
/** Hours of history the readings need before the first hour they describe (7 days and a margin). */
export const WARMUP_HOURS = 170;
export const FEATURES = ["r1", "r4", "r24", "r168", "vol24", "relvol", "pos24", "b1", "b24", "x1", "x24", "hs", "hc"] as const;

/** Hourly closes of several coins and BTC on one grid of hours (NaN where a coin has no candle). */
export interface Aligned {
  times: number[];
  coins: { symbol: string; close: Float64Array; high: Float64Array; low: Float64Array; value: Float64Array }[];
  btc: Float64Array;
}

/** Puts closed hourly candles on BTC's grid of hours. */
export function align(coins: { symbol: string; candles: Candle[] }[], btc: Candle[]): Aligned {
  const times = btc.map((b) => b.time);
  const at = new Map(times.map((t, i) => [t, i]));
  const n = times.length;
  return {
    times,
    btc: Float64Array.from(btc, (b) => b.close),
    coins: coins.map(({ symbol, candles }) => {
      const s = { symbol, close: new Float64Array(n).fill(NaN), high: new Float64Array(n).fill(NaN), low: new Float64Array(n).fill(NaN), value: new Float64Array(n).fill(NaN) };
      for (const c of candles) {
        const i = at.get(c.time);
        if (i === undefined) continue;
        s.close[i] = c.close;
        s.high[i] = c.high;
        s.low[i] = c.low;
        s.value[i] = c.volume * c.close;
      }
      return s;
    }),
  };
}

const lr = (a: Float64Array, i: number, k: number) => Math.log(a[i] / a[i - k]);

/**
 * Readings of every coin at the close of hour `i` (null when a coin lacks the history): its own moves over
 * 1, 4, 24 and 168 hours in units of its hourly volatility, that volatility, the last hour's traded value
 * against the day's average, where it closed in the day's range, BTC's moves, its moves against the other
 * coins' average, and the hour of the day.
 */
export function readings(a: Aligned, i: number): (number[] | null)[] {
  if (i < WARMUP_HOURS) return a.coins.map(() => null);
  const ok = a.coins.map((s) => s.close[i] > 0 && s.close[i - 24] > 0 && s.close[i - 1] > 0);
  const n = ok.filter(Boolean).length;
  let x1 = 0;
  let x24 = 0;
  a.coins.forEach((s, j) => {
    if (!ok[j]) return;
    x1 += lr(s.close, i, 1) / n;
    x24 += lr(s.close, i, 24) / n;
  });
  const hour = new Date(a.times[i] + HOUR).getUTCHours();
  return a.coins.map((s, j) => {
    const c = s.close;
    if (!ok[j] || !(c[i - 168] > 0)) return null;
    let m = 0;
    let m2 = 0;
    for (let k = i - 23; k <= i; k++) {
      const r = Math.log(c[k] / c[k - 1]);
      m += r;
      m2 += r * r;
    }
    const vol = Math.sqrt(Math.max(m2 / 24 - (m / 24) ** 2, 1e-12));
    let value = 0;
    for (let k = i - 24; k < i; k++) value += s.value[k] || 0;
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - 23; k <= i; k++) {
      if (s.high[k] > hi) hi = s.high[k];
      if (s.low[k] < lo) lo = s.low[k];
    }
    const x = [
      lr(c, i, 1) / vol,
      lr(c, i, 4) / vol / 2,
      lr(c, i, 24) / vol / 4.9,
      lr(c, i, 168) / vol / 13,
      Math.log(vol),
      Math.log(((s.value[i] || 0) + 1) / (value / 24 + 1)),
      (c[i] - lo) / (hi - lo || 1),
      lr(a.btc, i, 1),
      lr(a.btc, i, 24),
      lr(c, i, 1) - x1,
      lr(c, i, 24) - x24,
      Math.sin((2 * Math.PI * hour) / 24),
      Math.cos((2 * Math.PI * hour) / 24),
    ];
    return x.every(Number.isFinite) ? x : null;
  });
}

export interface ProbabilityModel {
  /** Intercept first, then one weight per standardized reading. */
  w: number[];
  mu: number[];
  sd: number[];
  trainedAt: number;
  /** Coin-hours it learned from, and how often they beat the cost. */
  samples: number;
  baseRate: number;
}

/** Coin-hours from hour `from` up to `to` (both indexes) whose next hour is known, labelled won/lost. */
export function examples(a: Aligned, from: number, to: number, cost: number): { x: number[]; won: boolean }[] {
  const out: { x: number[]; won: boolean }[] = [];
  for (let i = Math.max(from, WARMUP_HOURS); i <= to && i + 1 < a.times.length; i++) {
    readings(a, i).forEach((x, j) => {
      const next = a.coins[j].close[i + 1];
      if (x && next > 0) out.push({ x, won: next / a.coins[j].close[i] - 1 > cost });
    });
  }
  return out;
}

/** Logistic regression by Newton's method, readings standardized, a light L2 penalty on the weights. */
export function fit(rows: { x: number[]; won: boolean }[], trainedAt: number, lambda = 1): ProbabilityModel {
  const k = FEATURES.length;
  const d = k + 1;
  const mu = new Array<number>(k).fill(0);
  const sd = new Array<number>(k).fill(0);
  for (const r of rows) r.x.forEach((v, f) => (mu[f] += v / rows.length));
  for (const r of rows) r.x.forEach((v, f) => (sd[f] += (v - mu[f]) ** 2 / rows.length));
  for (let f = 0; f < k; f++) sd[f] = Math.sqrt(sd[f]) || 1;
  const X = rows.map((r) => [1, ...r.x.map((v, f) => (v - mu[f]) / sd[f])]);
  const w = new Array<number>(d).fill(0);
  for (let it = 0; it < 8; it++) {
    const g = new Array<number>(d).fill(0);
    const h = Array.from({ length: d }, () => new Array<number>(d).fill(0));
    X.forEach((x, n) => {
      let z = 0;
      for (let a = 0; a < d; a++) z += w[a] * x[a];
      const p = 1 / (1 + Math.exp(-z));
      const q = p * (1 - p);
      const y = rows[n].won ? 1 : 0;
      for (let a = 0; a < d; a++) {
        g[a] += (y - p) * x[a];
        for (let b = a; b < d; b++) h[a][b] += q * x[a] * x[b];
      }
    });
    for (let a = 0; a < d; a++) {
      for (let b = 0; b < a; b++) h[a][b] = h[b][a];
      if (a) {
        h[a][a] += lambda;
        g[a] -= lambda * w[a];
      }
    }
    const step = solve(h, g);
    if (!step) break;
    step.forEach((v, a) => (w[a] += v));
  }
  const won = rows.filter((r) => r.won).length;
  return { w, mu, sd, trainedAt, samples: rows.length, baseRate: rows.length ? won / rows.length : 0 };
}

/** Gaussian elimination with partial pivoting; null when the system is singular. */
function solve(m: number[][], v: number[]): number[] | null {
  const n = v.length;
  const a = m.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}

export function probability(m: ProbabilityModel, x: number[]): number {
  let z = m.w[0];
  for (let f = 0; f < x.length; f++) z += m.w[f + 1] * ((x[f] - m.mu[f]) / m.sd[f]);
  return 1 / (1 + Math.exp(-z));
}

/** Coins at the close of hour `i`, most likely to win first. */
export function rank(a: Aligned, i: number, m: ProbabilityModel): { symbol: string; p: number }[] {
  return readings(a, i)
    .flatMap((x, j) => (x ? [{ symbol: a.coins[j].symbol, p: probability(m, x) }] : []))
    .sort((x, y) => y.p - x.p);
}
