import { advance, distance, fill, isFilled, leadersAllow, orderPrice, type Bar, type MechasParams, type Order, type Position, type Side } from "./core.js";
import type { Pick } from "./universe.js";

// Variants in the shadow: on the same coins and minutes the bot follows alternative entry distances,
// stops and time limits as hypothetical trades, and moves a side to another variant only when it beat
// the active one clearly over a long stretch. Measured Mar–Sep 2026 (README): letting the best recent
// variant take over after a few weeks picked noise (as often worse as better, the ranking of variants
// barely carried from one month to the next); with this strict rule (60 days, advantage z ≥ 3) no switch
// fired in those 6 months, so it costs nothing and acts only on a lasting change in the market.

export interface Variant {
  k: number;
  takeProfit: number;
  stop: number;
  maxMinutes: number;
}

export interface TuneConfig {
  autoTune: boolean;
  tuneMinDays: number;
  tuneHalfLifeDays: number;
  tuneZ: number;
}

export interface ShadowState {
  /** UTC day (days since 1970) the measurement began. */
  since: number;
  positions: { key: string; pos: Position }[];
  /** Sum of net returns per UTC day: side → variant → day → sum. */
  daily: Record<Side, Record<string, Record<string, number>>>;
  /** Variant each side trades with. */
  active: Record<Side, string>;
  /** Last UTC day the switch rule ran. */
  checkedDay: number;
  switches: { time: number; side: Side; from: string; to: string; z: number; days: number }[];
}

export interface Comparison {
  key: string;
  /** Decayed mean of the variant's daily sum of returns. */
  mean: number;
  /** Decayed mean daily advantage over the active variant, and its z-score. */
  edge: number;
  z: number;
}

const MINUTE = 60_000;
const DAY = 86_400_000;
const KEEP_DAYS = 180;

export const dayOf = (t: number) => Math.floor(t / DAY);
export const variantKey = (v: Variant) => `k${v.k} obj${v.takeProfit} stop${v.stop} ${v.maxMinutes}m`;
export const describeVariant = (v: Variant) => `orden a ${v.k}σ, objetivo ${v.takeProfit}×, stop ${v.stop}×, máximo ${v.maxMinutes} min`;

export function emptyShadow(base: string, today: number): ShadowState {
  return { since: today, positions: [], daily: { long: {}, short: {} }, active: { long: base, short: base }, checkedDay: today, switches: [] };
}

export interface MarketView {
  bar(symbol: string, t: number): Bar | undefined;
  /** σ15 from closes up to minute t. */
  sigma(symbol: string, t: number): number;
  leaderMoves(t: number): number[];
}

/** One minute of every variant: exits, then fills of the orders each would have had resting. */
export function shadowMinute(s: ShadowState, variants: Variant[], coins: Pick[], t: number, m: MarketView, base: MechasParams, shorts: boolean): void {
  const record = (side: Side, key: string, ret: number, at: number) => {
    const byKey = (s.daily[side][key] ??= {});
    const d = String(dayOf(at));
    byKey[d] = (byKey[d] ?? 0) + ret;
  };
  const params = new Map(variants.map((v) => [variantKey(v), { ...base, ...v }]));
  // A variant with a position on a coin had no order resting there during this minute.
  const busy = new Set(s.positions.map((x) => `${x.key}|${x.pos.symbol}`));
  for (const x of [...s.positions]) {
    const p = params.get(x.key);
    const bar = m.bar(x.pos.symbol, t);
    const drop = () => s.positions.splice(s.positions.indexOf(x), 1);
    if (!p) drop();
    else if (bar && bar.time > x.pos.openedAt) {
      const done = advance(x.pos, bar, p);
      if (done) record(done.side, x.key, done.ret, done.closedAt), drop();
    } else if (!bar && t > x.pos.expiresAt + 5 * MINUTE) drop(); // coin no longer followed
  }
  const moves = m.leaderMoves(t - MINUTE);
  const sides: Side[] = shorts ? ["long", "short"] : ["long"];
  for (const coin of coins) {
    const bar = m.bar(coin.symbol, t);
    const ref = m.bar(coin.symbol, t - MINUTE)?.close;
    const sigma = m.sigma(coin.symbol, t - MINUTE);
    if (!bar || !ref || !Number.isFinite(sigma)) continue;
    for (const [key, p] of params) {
      if (busy.has(`${key}|${coin.symbol}`)) continue;
      const dist = distance(sigma, p);
      const hits = sides
        .filter((side) => leadersAllow(side, moves, p))
        .map((side): Order => ({ symbol: coin.symbol, side, price: orderPrice(side, ref, dist), distance: dist, forTime: t, notional: 1, virtual: true, tick: coin.tick, predicted: { pWin: NaN, mean: NaN } }))
        .filter((o) => isFilled(o, bar, p));
      if (hits.length !== 1) continue;
      const { position, closed } = fill(hits[0], bar, p);
      if (closed) record(closed.side, key, closed.ret, closed.closedAt);
      else s.positions.push({ key, pos: position });
    }
  }
}

/** Every variant against the side's active one over the complete days measured (decayed). */
export function compare(s: ShadowState, side: Side, keys: string[], today: number, halfLifeDays: number): { days: number; rows: Comparison[] } {
  const lam = 0.5 ** (1 / halfLifeDays);
  const val = (key: string, d: number) => s.daily[side][key]?.[String(d)] ?? 0;
  const cur = s.active[side];
  const rows = keys.map((key) => {
    let w = 0, w2 = 0, own = 0, sx = 0, sxx = 0;
    for (let d = s.since; d < today; d++) {
      const k = lam ** (today - d);
      const x = val(key, d) - val(cur, d);
      w += k;
      w2 += k * k;
      own += k * val(key, d);
      sx += k * x;
      sxx += k * x * x;
    }
    if (!w) return { key, mean: 0, edge: 0, z: 0 };
    const edge = sx / w;
    const variance = sxx / w - edge * edge;
    const nEff = (w * w) / w2;
    return { key, mean: own / w, edge, z: variance > 1e-12 ? edge / Math.sqrt(variance / nEff) : 0 };
  });
  return { days: Math.max(0, today - s.since), rows: rows.sort((a, b) => b.mean - a.mean) };
}

/** The variant a side should move to today, if one beat the active one clearly; null otherwise. */
export function tune(s: ShadowState, side: Side, keys: string[], today: number, c: TuneConfig): Comparison | null {
  if (!c.autoTune || today - s.since < c.tuneMinDays) return null;
  const best = compare(s, side, keys, today, c.tuneHalfLifeDays)
    .rows.filter((r) => r.key !== s.active[side] && r.mean > 0 && r.z >= c.tuneZ)
    .sort((a, b) => b.z - a.z)[0];
  return best ?? null;
}

/** Forgets days older than half a year. */
export function trimShadow(s: ShadowState, today: number): void {
  const oldest = today - KEEP_DAYS;
  if (s.since < oldest) s.since = oldest;
  for (const side of ["long", "short"] as Side[])
    for (const byDay of Object.values(s.daily[side])) for (const d of Object.keys(byDay)) if (+d < oldest) delete byDay[d];
}
