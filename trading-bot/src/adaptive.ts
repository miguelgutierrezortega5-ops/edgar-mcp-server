import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backtest, type SeriesInput } from "./backtest.js";
import type { PaperCosts } from "./brokers/paper.js";
import { amihud, decayedEvidence, rollingPercentile, vpin, type Evidence } from "./quant.js";
import type { RiskParams } from "./risk.js";
import { TIMEFRAME_MS } from "./timeframes.js";
import type { Candle, Market } from "./types.js";

// Adaptive layer: no pattern is assumed to keep working. Every signal's outcome (taken or not: in
// markets the counterfactual is public, so there is no need to explore blindly) is scored as a log
// return, per strategy group and market context (order-flow toxicity, liquidity). Evidence decays
// with a half-life, thin contexts borrow strength from their group (empirical Bayes), and each
// context gets a size multiplier: 0 when the recent evidence does not support a positive edge,
// up to 1 when it clearly does, capped by a fraction of the Kelly bet (log-growth optimal).

export interface AdaptiveConfig {
  enabled: boolean;
  everyHours: number;
  windowDays: number;
  halfLifeDays: number;
  /** Weight, in trades, of the group's evidence on each context. */
  priorTrades: number;
  /** Below this probability of a positive edge, the context is not traded. */
  minProbability: number;
  /** From this probability on, full size. */
  fullProbability: number;
}

export interface Arm {
  group: string;
  context: string;
  evidence: Evidence;
  scale: number;
}

export interface AdaptiveState {
  updatedAt: number;
  arms: Arm[];
}

export interface Outcome {
  group: string;
  context: string;
  /** When the outcome became known (trade close). */
  time: number;
  /** Net log return of the trade. */
  value: number;
}

export const groupOf = (m: Pick<Market, "strategyName" | "timeframe" | "type">) => `${m.strategyName} ${m.timeframe} ${m.type}`;

/**
 * Market context of every bar: order-flow toxicity (VPIN) and liquidity (Amihud), each as high or
 * normal against the market's own recent history. Without taker-volume data only liquidity is used.
 */
export function contexts(candles: Candle[]): string[] {
  const volumes = candles.map((c) => c.volume).sort((a, b) => a - b);
  const bucket = (volumes[Math.floor(volumes.length / 2)] ?? 0) * 10;
  const tox = rollingPercentile(vpin(candles, bucket, 50), 300);
  const illiq = rollingPercentile(amihud(candles, 60), 300);
  return candles.map((_, i) => `${tox[i] > 0.8 ? "flujo tóxico" : Number.isFinite(tox[i]) ? "flujo normal" : "flujo ?"}, ${illiq[i] > 0.8 ? "iliquidez alta" : "liquidez normal"}`);
}

/** Outcomes of every signal of each market traded alone (no position limit), with its context at the signal. */
export function collectOutcomes(series: SeriesInput[], o: { risk: RiskParams; costs: PaperCosts; from: number; until?: number }): Outcome[] {
  const out: Outcome[] = [];
  for (const s of series) {
    let r;
    try {
      r = backtest({ ...s, risk: { ...o.risk, maxBarVolumePct: 0, dailyLossLimitPct: 100, maxDrawdownPct: 100 }, costs: o.costs, startingBalance: 1e9, tradeFrom: o.from, tradeUntil: o.until });
    } catch {
      continue;
    }
    const ctx = contexts(s.candles);
    const step = TIMEFRAME_MS[s.market.timeframe];
    const index = new Map(s.candles.map((c, i) => [c.time, i]));
    for (const t of r.trades) {
      const i = index.get(t.openedAt - step); // the signal bar, just before the entry bar
      const notional = t.entryPrice * t.units;
      if (!(notional > 0)) continue;
      out.push({ group: groupOf(s.market), context: i === undefined ? "?" : ctx[i], time: t.closedAt, value: Math.log(Math.max(1e-9, 1 + t.pnl / notional)) });
    }
  }
  return out;
}

export function scaleOf(e: Evidence, c: AdaptiveConfig): number {
  if (e.pPositive < c.minProbability || e.kelly <= 0) return 0;
  const byProbability = e.pPositive >= c.fullProbability ? 1 : 0.25 + (0.75 * (e.pPositive - c.minProbability)) / (c.fullProbability - c.minProbability);
  return Math.min(1, byProbability);
}

/** Evidence per group and context as of `now` (only outcomes known by then). */
export function assess(outcomes: Outcome[], now: number, c: AdaptiveConfig): AdaptiveState {
  const halfLife = c.halfLifeDays * 86_400_000;
  const known = outcomes.filter((o) => o.time <= now);
  const arms: Arm[] = [];
  for (const group of new Set(known.map((o) => o.group))) {
    const inGroup = known.filter((o) => o.group === group);
    const g = decayedEvidence(inGroup, now, halfLife);
    arms.push({ group, context: "*", evidence: g, scale: scaleOf(g, c) });
    for (const context of new Set(inGroup.map((o) => o.context))) {
      const e = decayedEvidence(inGroup.filter((o) => o.context === context), now, halfLife, { mean: g.mean, n: c.priorTrades });
      arms.push({ group, context, evidence: e, scale: scaleOf(e, c) });
    }
  }
  return { updatedAt: now, arms };
}

/** Size multiplier for a signal (1 when there is no evidence yet: the static rules apply). */
export function scaleFor(state: AdaptiveState | null, m: Pick<Market, "strategyName" | "timeframe" | "type">, context: string): { scale: number; arm?: Arm } {
  const group = groupOf(m);
  const arm = state?.arms.find((a) => a.group === group && a.context === context) ?? state?.arms.find((a) => a.group === group && a.context === "*");
  return arm ? { scale: arm.scale, arm } : { scale: 1 };
}

export function describeArm(a: Arm): string {
  const e = a.evidence;
  return `${a.group} | ${a.context}: ${e.n.toFixed(1)} ops efectivas, media ${(e.mean * 100).toFixed(2)}%, P(ventaja>0) ${(e.pPositive * 100).toFixed(0)}%, Kelly ${e.kelly.toFixed(1)} → tamaño ×${a.scale.toFixed(2)}`;
}

const fileOf = (dir: string) => join(dir, "adaptativo.json");

export function loadAdaptive(dir: string): AdaptiveState | null {
  return existsSync(fileOf(dir)) ? (JSON.parse(readFileSync(fileOf(dir), "utf8")) as AdaptiveState) : null;
}

export function saveAdaptive(dir: string, state: AdaptiveState): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(fileOf(dir), JSON.stringify(state, null, 2));
  appendFileSync(join(dir, "adaptativo.log"), JSON.stringify({ fecha: new Date(state.updatedAt).toISOString(), brazos: state.arms.map((a) => ({ grupo: a.group, contexto: a.context, n: +a.evidence.n.toFixed(1), media: +a.evidence.mean.toFixed(5), p: +a.evidence.pPositive.toFixed(3), tamaño: +a.scale.toFixed(2) })) }) + "\n");
}
