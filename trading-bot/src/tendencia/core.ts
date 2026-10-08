// Challenge 3, trend following on daily closes. Two signals:
// - "medias" (in use since 2026-10-08): the share of moving averages (50, 100, 150, 200 and 250 days) the
//   close is above sets how much of the coin's slot is held: 3 of 5 = 60%. On BTC alone it beat the
//   channels below on two periods (README): 2019-21 +222% vs +152%, 2022-Oct 2026 +205% vs +137%.
// - "canales": Zarattini, Pagani & Barbon (2025), "Catching Crypto Trends": for each lookback L a model
//   enters when the close beats the highest of the previous L closes and leaves when it falls under its
//   trailing stop, the highest midpoint of that channel since entry; the coin is held while at least
//   `threshold` of the models are in a trend.
// Each coin has an equal slot of the account; what is not held waits in cash.

export interface DayBar {
  /** Start of the UTC day. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface TrendView {
  /** Models in a trend after the last close. */
  on: number;
  /** Models with enough history to have an opinion. */
  models: number;
}

/** The lookback models of one coin, fed one daily close at a time. */
export class TrendModel {
  private readonly closes: number[] = [];
  private readonly state: { on: boolean; stop: number }[];
  /** Closes seen so far. */
  private seen = 0;

  constructor(private readonly lookbacks: number[]) {
    this.state = lookbacks.map(() => ({ on: false, stop: 0 }));
  }

  /** Feeds a whole series (oldest first). */
  static of(closes: number[], lookbacks: number[]): TrendModel {
    const m = new TrendModel(lookbacks);
    for (const c of closes) m.add(c);
    return m;
  }

  add(close: number): void {
    const n = this.closes.length;
    this.lookbacks.forEach((len, j) => {
      if (n < len) return;
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = n - len; k < n; k++) {
        if (this.closes[k] > hi) hi = this.closes[k];
        if (this.closes[k] < lo) lo = this.closes[k];
      }
      const mid = (hi + lo) / 2;
      const s = this.state[j];
      if (s.on) {
        s.stop = Math.max(s.stop, mid);
        if (close < s.stop) s.on = false;
      } else if (close > hi) {
        s.on = true;
        s.stop = mid;
      }
    });
    this.closes.push(close);
    this.seen++;
    // The longest lookback is all the memory a model needs.
    const keep = Math.max(...this.lookbacks);
    if (this.closes.length > keep * 2) this.closes.splice(0, this.closes.length - keep);
  }

  /** Only lookbacks that had L earlier closes count (as in the study). */
  view(): TrendView {
    const has = (len: number) => this.seen > len;
    return { on: this.state.filter((s, j) => s.on && has(this.lookbacks[j])).length, models: this.lookbacks.filter(has).length };
  }
}

/** The share of moving averages a coin's close is above, fed one daily close at a time. */
export class AverageModel {
  private readonly closes: number[] = [];
  private last = NaN;

  constructor(private readonly lengths: number[]) {}

  static of(closes: number[], lengths: number[]): AverageModel {
    const m = new AverageModel(lengths);
    for (const c of closes) m.add(c);
    return m;
  }

  add(close: number): void {
    this.closes.push(close);
    this.last = close;
    const keep = Math.max(...this.lengths);
    if (this.closes.length > keep * 2) this.closes.splice(0, this.closes.length - keep);
  }

  /** Averages that include the last close, like a chart's moving average. */
  view(): TrendView {
    const n = this.closes.length;
    let on = 0;
    let models = 0;
    for (const len of this.lengths) {
      if (n < len) continue;
      let sum = 0;
      for (let k = n - len; k < n; k++) sum += this.closes[k];
      models++;
      if (this.last > sum / len) on++;
    }
    return { on, models };
  }
}

export interface SignalConfig {
  signal: "medias" | "canales";
  /** Moving-average lengths for "medias", in days. */
  averages: number[];
  /** Channel lookbacks for "canales", in days. */
  lookbacks: number[];
}

/** A fresh model for one coin, of the configured kind. */
export const makeModel = (c: SignalConfig): { add(close: number): void; view(): TrendView } => (c.signal === "medias" ? new AverageModel(c.averages) : new TrendModel(c.lookbacks));

/** In a trend when at least `threshold` of the models with an opinion say so. */
export const inTrend = (v: TrendView, threshold: number) => v.models > 0 && v.on / v.models >= threshold;

export interface Holding {
  units: number;
  /** USD paid for the units held, fees included (for the result of each sale). */
  cost: number;
}

export interface Fill {
  symbol: string;
  side: "buy" | "sell";
  units: number;
  price: number;
  /** USD traded, before the fee. */
  notional: number;
  fee: number;
  /** Result of the units sold, after both fees (sales only). */
  pnl?: number;
  /** "entra" = enters a trend, "sale" = leaves it, "ajuste" = back to its slot. */
  reason: "entra" | "sale" | "ajuste";
}

export interface RebalanceConfig {
  minOrderUsd: number;
  /** Fee plus slippage per side, as a fraction. */
  cost: number;
}

/**
 * Moves the holdings towards `weights` (fraction of the account per coin) at `prices`. Sales go first and
 * purchases never spend more cash than there is (a spot account). Orders under the exchange's minimum are
 * skipped, and a slot too small to buy stays in cash (what a small account can do).
 */
export function rebalance(cash: number, holdings: Record<string, Holding>, prices: Record<string, number>, weights: Record<string, number>, c: RebalanceConfig): { cash: number; fills: Fill[] } {
  const fills: Fill[] = [];
  const value = cash + Object.entries(holdings).reduce((a, [s, h]) => a + h.units * (prices[s] ?? 0), 0);
  const orders = Object.keys(weights).flatMap((symbol) => {
    const price = prices[symbol];
    if (!(price > 0)) return [];
    const h = (holdings[symbol] ??= { units: 0, cost: 0 });
    let target = weights[symbol] * value;
    if (target < c.minOrderUsd) target = 0;
    const current = h.units * price;
    const delta = target - current;
    if (!delta || (target > 0 && Math.abs(delta) < c.minOrderUsd)) return [];
    return [{ symbol, price, h, target, current, delta }];
  });
  for (const o of orders.sort((a, b) => a.delta - b.delta)) {
    const { symbol, price, h, target, current } = o;
    const reason = !current ? "entra" : !target ? "sale" : "ajuste";
    if (o.delta > 0) {
      const delta = Math.min(o.delta, cash / (1 + c.cost));
      if (delta < c.minOrderUsd) continue;
      const fee = delta * c.cost;
      const units = delta / price;
      cash -= delta + fee;
      h.units += units;
      h.cost += delta + fee;
      fills.push({ symbol, side: "buy", units, price, notional: delta, fee, reason });
    } else {
      const sold = target ? -o.delta / price : h.units;
      const notional = sold * price;
      const fee = notional * c.cost;
      const basis = (h.cost * sold) / h.units;
      cash += notional - fee;
      h.cost -= basis;
      h.units -= sold;
      if (!target) (h.units = 0), (h.cost = 0);
      fills.push({ symbol, side: "sell", units: sold, price, notional, fee, pnl: notional - fee - basis, reason });
    }
  }
  return { cash, fills };
}

/**
 * Each coin's share of the account: an equal slot, filled in proportion to its models in a trend
 * (`proportional`, the moving averages) or whole once `threshold` of them agree (the channels).
 */
export function trendWeights(views: Record<string, TrendView>, coins: string[], threshold: number, proportional = false): Record<string, number> {
  const share = (v: TrendView | undefined) => (!v || !v.models ? 0 : proportional ? v.on / v.models : inTrend(v, threshold) ? 1 : 0);
  return Object.fromEntries(coins.map((s) => [s, share(views[s]) / coins.length]));
}
