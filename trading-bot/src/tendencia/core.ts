// Challenge 3, trend following on daily closes, after Zarattini, Pagani & Barbon (2025), "Catching Crypto
// Trends": an ensemble of Donchian channels. For each lookback L a model enters when the close beats the
// highest of the previous L closes and leaves when it falls under its trailing stop, the highest midpoint of
// that channel since entry. A coin is held while at least `threshold` of the models are in a trend, with an
// equal slot of the account; out of trend its slot waits in cash.
// Measured here (README, Binance spot 2022 to Oct 2026, the 5 largest coins of Jan 2022, 50 USD, 0.15% per
// side): +156%, worst drop -25%, against BTC +79% with a -67% drop; after the paper came out +9.8%.

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

/** Equal slots for the coins in a trend, nothing for the rest. */
export function trendWeights(views: Record<string, TrendView>, coins: string[], threshold: number): Record<string, number> {
  return Object.fromEntries(coins.map((s) => [s, views[s] && inTrend(views[s], threshold) ? 1 / coins.length : 0]));
}
