import { decayedEvidence } from "../quant.js";
import type { Side } from "./core.js";

// Prediction vs. outcome, per side (wick buys, wick shorts). Every trade the strategy would take counts,
// real or not (side paused, no room left): in markets the counterfactual is public, so a paused side keeps
// being measured and can come back. Recent trades weigh more (half-life). The backtest enters as a prior
// worth a few trades, so early results neither switch a side off nor on by themselves.
// A side trades only while its estimated win probability is above 50% AND its mean return after costs is
// positive with enough confidence; the size grows with that confidence.

export interface Outcome {
  side: Side;
  time: number;
  /** Net return on the notional. */
  ret: number;
  virtual: boolean;
}

export interface LearnConfig {
  halfLifeDays: number;
  priorTrades: number;
  priorMean: number;
  priorWinRate: number;
  /** Below this effective number of real outcomes the prior dominates and the side keeps full size. */
  minTrades: number;
  minProbability: number;
  fullProbability: number;
}

export interface SideView {
  side: Side;
  /** Effective number of outcomes (after decay), without the prior. */
  n: number;
  pWin: number;
  mean: number;
  /** Probability that the true mean return is positive. */
  pPositive: number;
  /** 0 = only observe, up to 1 = full size. */
  scale: number;
  why: string;
}

export function assessSide(outcomes: Outcome[], side: Side, now: number, c: LearnConfig): SideView {
  const halfLife = c.halfLifeDays * 86_400_000;
  const mine = outcomes.filter((o) => o.side === side && o.time <= now);
  const ev = decayedEvidence(
    mine.map((o) => ({ time: o.time, value: o.ret })),
    now,
    halfLife,
    { mean: c.priorMean, n: c.priorTrades },
  );
  let w = 0;
  let wins = 0;
  for (const o of mine) {
    const k = 0.5 ** ((now - o.time) / halfLife);
    w += k;
    if (o.ret > 0) wins += k;
  }
  const pWin = (wins + c.priorWinRate * c.priorTrades) / (w + c.priorTrades);
  const base = { side, n: ev.n, pWin, mean: ev.mean, pPositive: ev.pPositive };
  if (pWin <= 0.5) return { ...base, scale: 0, why: `gana el ${(pWin * 100).toFixed(0)}% (necesita más del 50%)` };
  if (ev.mean <= 0) return { ...base, scale: 0, why: `media ${(ev.mean * 100).toFixed(2)}% tras comisiones` };
  if (ev.n < c.minTrades) return { ...base, scale: 1, why: `pocas operaciones aún (${ev.n.toFixed(0)}): manda el backtest` };
  if (ev.pPositive < c.minProbability) return { ...base, scale: 0, why: `confianza ${(ev.pPositive * 100).toFixed(0)}% de que gane (necesita ${(c.minProbability * 100).toFixed(0)}%)` };
  const scale = ev.pPositive >= c.fullProbability ? 1 : 0.25 + (0.75 * (ev.pPositive - c.minProbability)) / (c.fullProbability - c.minProbability);
  return { ...base, scale, why: `confianza ${(ev.pPositive * 100).toFixed(0)}%` };
}

/** Realized vs. predicted win rate of closed trades: how well the bot's own estimates hold up. */
export function calibration(trades: { ret: number; predicted: { pWin: number } }[]): { n: number; predicted: number; realized: number } {
  const n = trades.length;
  if (!n) return { n, predicted: NaN, realized: NaN };
  return {
    n,
    predicted: trades.reduce((a, t) => a + t.predicted.pWin, 0) / n,
    realized: trades.filter((t) => t.ret > 0).length / n,
  };
}
