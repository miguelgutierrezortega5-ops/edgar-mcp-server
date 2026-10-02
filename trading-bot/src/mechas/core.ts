// Wick hunter ("cazador de mechas"), challenge 2. Every minute each selected altcoin gets a resting buy
// order k·σ15 below the last close and a resting sell (short) order k·σ15 above it (σ15 = recent
// 15-minute volatility). A fill is a wick: a stop hunt or a thin order book swept for a moment.
// The position aims back at the price before the wick (take profit = 1 distance), with a stop one
// distance beyond the fill and a 30-minute time stop.
//
// Measured on 1-minute Binance futures candles, Jun–Sep 2026, choosing each month the 12 most volatile
// coins of the previous month (README, "Reto 2"): wick buys +0.35% to +0.90% per trade net of fees,
// wick shorts +0.18% to +0.56%, both only while BTC, ETH and SOL are calm; wicks during a crash of the
// big coins keep falling. Orders close to the price win more often but lose after fees.
//
// The bot learns only of a fill when the minute closes, so exits are modelled that way: at that close
// it exits at market if price is already past the target or the stop; otherwise both orders work from
// the next minute (the stop first when a candle touches both).

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type Side = "long" | "short";

export interface MechasParams {
  /** Order distance from the last close, in σ15. */
  k: number;
  /** Target and stop, in units of that distance. */
  takeProfit: number;
  stop: number;
  maxMinutes: number;
  /** Minimum order distance, as a fraction (0.003 = 0.3%). */
  minDistance: number;
  /** How far price must trade past an order to count as filled (beyond one tick), as a fraction. */
  through: number;
  makerFee: number;
  takerFee: number;
  slippage: number;
  /** Leaders' 5-minute move that blocks longs (≤ -x) and shorts (≥ +x), as a fraction. */
  leaderMove: number;
}

export interface Prediction {
  /** Estimated probability of a winning trade and mean net return when the order was placed. */
  pWin: number;
  mean: number;
}

export interface Order {
  symbol: string;
  side: Side;
  price: number;
  /** Distance from the reference close, as a fraction. */
  distance: number;
  /** Start time of the minute the order rests in. */
  forTime: number;
  notional: number;
  /** Not traded (side paused by the learner, or no room): followed only to keep learning. */
  virtual: boolean;
  /** Extra fill and slippage margin for the symbol's tick size, as a fraction. */
  tick: number;
  predicted: Prediction;
}

export interface Position extends Order {
  entry: number;
  takeProfit: number;
  stopLoss: number;
  openedAt: number;
  expiresAt: number;
  units: number;
}

export type ExitReason = "objetivo" | "stop" | "tiempo";

export interface ClosedTrade extends Position {
  exit: number;
  closedAt: number;
  reason: ExitReason;
  pnl: number;
  /** Net return on the notional. */
  ret: number;
}

/** Standard deviation of the last `window` 1-minute log returns, scaled to 15 minutes. */
export function sigma15(closes: number[], window = 240): number {
  if (closes.length < window + 1) return NaN;
  let s = 0;
  let s2 = 0;
  for (let i = closes.length - window; i < closes.length; i++) {
    const r = Math.log(closes[i] / closes[i - 1]);
    if (!Number.isFinite(r)) return NaN;
    s += r;
    s2 += r * r;
  }
  return Math.sqrt(Math.max(0, s2 / window - (s / window) ** 2) * 15);
}

export function distance(sigma: number, p: Pick<MechasParams, "k" | "minDistance">): number {
  return Math.max(p.minDistance, p.k * sigma);
}

/** Leaders' 5-minute moves allow longs unless one fell `leaderMove`, shorts unless one rose as much. */
export function leadersAllow(side: Side, moves: number[], p: Pick<MechasParams, "leaderMove">): boolean {
  return side === "long" ? moves.every((m) => m > -p.leaderMove) : moves.every((m) => m < p.leaderMove);
}

export function orderPrice(side: Side, reference: number, dist: number): number {
  return side === "long" ? reference * (1 - dist) : reference * (1 + dist);
}

export function isFilled(o: Pick<Order, "side" | "price" | "tick">, bar: Bar, p: Pick<MechasParams, "through">): boolean {
  const through = p.through + o.tick;
  return o.side === "long" ? bar.low <= o.price * (1 - through) : bar.high >= o.price * (1 + through);
}

function close(pos: Position, bar: Bar, exit: number, fee: number, reason: ExitReason, p: MechasParams): ClosedTrade {
  const dir = pos.side === "long" ? 1 : -1;
  const pnl = dir * pos.units * (exit - pos.entry) - pos.notional * p.makerFee - pos.units * exit * fee;
  return { ...pos, exit, closedAt: bar.time, reason, pnl, ret: pnl / pos.notional };
}

/** Position from an order filled during `bar`; closed at that bar's close if price is already past the target or stop. */
export function fill(o: Order, bar: Bar, p: MechasParams): { position: Position; closed?: ClosedTrade } {
  const dir = o.side === "long" ? 1 : -1;
  const entry = o.price;
  const position: Position = {
    ...o,
    entry,
    takeProfit: entry * (1 + dir * p.takeProfit * o.distance),
    stopLoss: entry * (1 - dir * p.stop * o.distance),
    openedAt: bar.time,
    expiresAt: bar.time + p.maxMinutes * 60_000,
    units: o.notional / entry,
  };
  const slip = p.slippage + o.tick;
  if (dir * (bar.close - position.takeProfit) >= 0) return { position, closed: close(position, bar, bar.close, p.takerFee, "objetivo", p) };
  if (dir * (bar.close - position.stopLoss) <= 0) return { position, closed: close(position, bar, bar.close * (1 - dir * slip), p.takerFee, "stop", p) };
  return { position };
}

/** Advances an open position by a later minute; returns the closed trade when it exits. */
export function advance(pos: Position, bar: Bar, p: MechasParams): ClosedTrade | null {
  const long = pos.side === "long";
  const slip = p.slippage + pos.tick;
  const through = p.through + pos.tick;
  if (long ? bar.low <= pos.stopLoss : bar.high >= pos.stopLoss) {
    const worst = long ? Math.min(pos.stopLoss, bar.open) * (1 - slip) : Math.max(pos.stopLoss, bar.open) * (1 + slip);
    return close(pos, bar, worst, p.takerFee, "stop", p);
  }
  if (long ? bar.high >= pos.takeProfit * (1 + through) : bar.low <= pos.takeProfit * (1 - through)) {
    // A gap past the target fills at the open (better price, but as taker).
    const gapped = long ? bar.open >= pos.takeProfit : bar.open <= pos.takeProfit;
    return close(pos, bar, gapped ? bar.open : pos.takeProfit, gapped ? p.takerFee : p.makerFee, "objetivo", p);
  }
  if (bar.time >= pos.expiresAt) return close(pos, bar, bar.close * (long ? 1 - slip / 2 : 1 + slip / 2), p.takerFee, "tiempo", p);
  return null;
}
