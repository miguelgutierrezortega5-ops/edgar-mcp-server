import type { Candle } from "./types.js";

// Quantitative tools from the market-microstructure and statistics literature. None of them is a
// rule that always holds: they are measurements, and the bot only acts on them while recent data
// says they work.

// ---------- Normal distribution ----------

/** Standard normal CDF (Abramowitz-Stegun 7.1.26, error < 1.5e-7). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Inverse standard normal CDF (Acklam's algorithm, relative error < 1.2e-9). */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ---------- Logarithmic returns and regime ----------

/** ln(close_i / close_{i-1}); additive over time, unlike % returns. */
export function logReturns(candles: Candle[]): number[] {
  return candles.map((c, i) => (i ? Math.log(c.close / candles[i - 1].close) : 0));
}

/**
 * Hurst exponent of the log price over the last `window` bars: the slope of log(std of k-bar log
 * changes) against log(k). About 0.5 is a random walk, above it trends persist, below they revert.
 */
export function hurst(candles: Candle[], window = 300, lags = [2, 4, 8, 16, 32]): number {
  const logs = candles.slice(-window).map((c) => Math.log(c.close));
  const pts: [number, number][] = [];
  for (const k of lags) {
    if (logs.length <= k * 4) continue;
    const diffs: number[] = [];
    for (let i = k; i < logs.length; i++) diffs.push(logs[i] - logs[i - k]);
    const m = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - m) ** 2, 0) / diffs.length);
    if (sd > 0) pts.push([Math.log(k), Math.log(sd)]);
  }
  if (pts.length < 3) return NaN;
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  return pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
}

export function regimeName(h: number): string {
  return !Number.isFinite(h) ? "—" : h > 0.55 ? `tendencial (H ${h.toFixed(2)})` : h < 0.45 ? `revierte (H ${h.toFixed(2)})` : `aleatorio (H ${h.toFixed(2)})`;
}

// ---------- Order flow: who is trading ----------

/**
 * VPIN (Easley, López de Prado & O'Hara 2012), the volume-synchronized probability of informed
 * trading: bars are grouped into buckets of equal volume and VPIN is the average |buy - sell| / volume
 * of the last `buckets` buckets. High VPIN means one-sided, aggressive flow: someone who knows (or
 * wants) where price is going. Uses Binance's taker-buy volume, so no trade classification is needed.
 * Returns one value per bar (NaN until enough buckets or without taker data).
 */
export function vpin(candles: Candle[], bucketVolume: number, buckets = 50): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  const done: number[] = []; // |imbalance| of finished buckets
  let vol = 0;
  let buy = 0;
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c.takerBuy === undefined || !(bucketVolume > 0)) continue;
    let v = c.volume;
    const buyShare = c.volume > 0 ? c.takerBuy / c.volume : 0.5;
    while (v > 0) {
      const take = Math.min(v, bucketVolume - vol);
      vol += take;
      buy += take * buyShare;
      v -= take;
      if (vol >= bucketVolume - 1e-12) {
        const imb = Math.abs(2 * buy - vol);
        done.push(imb);
        sum += imb;
        if (done.length > buckets) sum -= done[done.length - buckets - 1];
        vol = 0;
        buy = 0;
      }
    }
    if (done.length >= buckets) out[i] = sum / (buckets * bucketVolume);
  }
  return out;
}

/**
 * Kyle's lambda over a rolling window: regression slope of log return on signed volume (buys minus
 * sells, in quote currency). It measures how far a unit of aggressive volume moves the price: high
 * lambda means a thin book, where a large player moves the market easily.
 */
export function kyleLambda(candles: Candle[], window = 60): number[] {
  const r = logReturns(candles);
  const s = candles.map((c) => (c.takerBuy === undefined ? NaN : (2 * c.takerBuy - c.volume) * c.close));
  return candles.map((_, i) => {
    if (i < window) return NaN;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let j = i - window + 1; j <= i; j++) {
      if (!Number.isFinite(s[j])) return NaN;
      sx += s[j];
      sy += r[j];
      sxx += s[j] * s[j];
      sxy += s[j] * r[j];
    }
    const varX = sxx / window - (sx / window) ** 2;
    return varX > 0 ? (sxy / window - (sx / window) * (sy / window)) / varX : NaN;
  });
}

/** Amihud illiquidity: average |log return| per unit of traded value over a rolling window. */
export function amihud(candles: Candle[], window = 60): number[] {
  const r = logReturns(candles);
  return candles.map((_, i) => {
    if (i < window) return NaN;
    let sum = 0;
    for (let j = i - window + 1; j <= i; j++) {
      const value = candles[j].volume * candles[j].close;
      sum += value > 0 ? Math.abs(r[j]) / value : 0;
    }
    return sum / window;
  });
}

/** Rank of each value within the trailing `window` values (0-1); 0.9 = higher than 90% of recent history. */
export function rollingPercentile(values: number[], window = 2000): number[] {
  return values.map((v, i) => {
    if (!Number.isFinite(v) || i < 100) return NaN;
    let below = 0;
    let n = 0;
    for (let j = Math.max(0, i - window); j < i; j++) {
      if (!Number.isFinite(values[j])) continue;
      n++;
      if (values[j] < v) below++;
    }
    return n >= 100 ? below / n : NaN;
  });
}

// ---------- Evidence that decays ----------

export interface Evidence {
  /** Effective number of observations after decay. */
  n: number;
  /** Weighted mean of the outcomes (log returns). */
  mean: number;
  sd: number;
  /** Probability that the true mean is positive, given the evidence. */
  pPositive: number;
  /** Kelly fraction mean / variance: the bet size that maximizes expected log growth. */
  kelly: number;
}

/**
 * Exponentially decayed statistics of outcomes: an outcome `halfLife` old counts half as much as
 * one from now. Old evidence fades, so a pattern that stops working loses its weight, and one
 * that starts working again regains it. `prior` shrinks thin evidence towards a group mean
 * (empirical Bayes) with the weight of `priorN` observations.
 */
export function decayedEvidence(outcomes: { time: number; value: number }[], now: number, halfLife: number, prior?: { mean: number; n: number }): Evidence {
  let w = 0;
  let sum = 0;
  for (const o of outcomes) {
    if (o.time > now) continue;
    const k = 0.5 ** ((now - o.time) / halfLife);
    w += k;
    sum += k * o.value;
  }
  const pw = prior?.n ?? 0;
  const mean = w + pw > 0 ? (sum + (prior?.mean ?? 0) * pw) / (w + pw) : 0;
  let ss = 0;
  for (const o of outcomes) if (o.time <= now) ss += 0.5 ** ((now - o.time) / halfLife) * (o.value - mean) ** 2;
  const sd = w > 0 ? Math.sqrt(ss / w) : 0;
  const se = sd / Math.sqrt(Math.max(w + pw, 1));
  return { n: w, mean, sd, pPositive: se > 0 ? normCdf(mean / se) : mean > 0 ? 1 : 0.5, kelly: sd > 0 ? mean / sd ** 2 : 0 };
}

// ---------- Multiple testing ----------

/**
 * Deflated Sharpe ratio (Bailey & López de Prado 2014): the probability that a strategy's true
 * Sharpe ratio is above zero, after accounting for having picked it as the best of `trials`
 * attempts, for its sample length and for non-normal returns. Below ~0.9 the "best" result is
 * likely luck. `returns` are per-period (e.g. daily) results.
 */
export function deflatedSharpe(returns: number[], trials: number, trialSharpeVariance?: number): number {
  const n = returns.length;
  if (n < 3) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  if (!(sd > 0)) return mean > 0 ? 1 : 0;
  const sr = mean / sd;
  const skew = returns.reduce((a, b) => a + ((b - mean) / sd) ** 3, 0) / n;
  const kurt = returns.reduce((a, b) => a + ((b - mean) / sd) ** 4, 0) / n;
  // Expected maximum Sharpe ratio among `trials` unskilled strategies.
  const gamma = 0.5772156649;
  const v = trialSharpeVariance ?? 1 / (n - 1);
  const sr0 = trials > 1 ? Math.sqrt(v) * ((1 - gamma) * normInv(1 - 1 / trials) + gamma * normInv(1 - 1 / (trials * Math.E))) : 0;
  const denom = Math.sqrt(Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
  return normCdf(((sr - sr0) * Math.sqrt(n - 1)) / denom);
}
