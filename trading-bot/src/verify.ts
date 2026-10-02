import type { Strategy, StrategyContext } from "./strategies/types.js";
import type { Candle, StrategyParams } from "./types.js";

// Look-ahead bias check (as Freqtrade's lookahead-analysis): a strategy must decide at bar i exactly
// the same with the whole history as with the history cut at bar i. If it does not, it is peeking
// at the future, and its backtests are fiction.

export interface LookaheadReport {
  checked: number;
  mismatches: { time: number; full: string; cut: string }[];
}

const describe = (s: ReturnType<Strategy["evaluate"]>) =>
  JSON.stringify([s.entry?.side ?? null, round(s.entry?.stopDistance), round(s.entry?.takeProfitDistance ?? undefined), s.entry?.maxBars ?? null, s.exitLong, s.exitShort]);
const round = (v: number | undefined) => (v === undefined ? null : Number(v.toPrecision(10)));

export function lookaheadCheck(o: { strategy: Strategy; params: StrategyParams; allowShort: boolean; candles: Candle[]; context?: StrategyContext; samples?: number }): LookaheadReport {
  const { strategy: s, params: p, candles } = o;
  const full = s.prepare(candles, p, o.context);
  const start = s.minCandles(p);
  const all: number[] = [];
  for (let i = start; i < candles.length; i++) all.push(i);
  // Every bar with a signal, plus an even sample of quiet ones.
  const fullSig = new Map(all.map((i) => [i, s.evaluate(full, i, p, o.allowShort, false)]));
  const active = all.filter((i) => fullSig.get(i)!.entry || fullSig.get(i)!.exitLong || fullSig.get(i)!.exitShort);
  const quota = Math.max(0, (o.samples ?? 200) - active.length);
  const step = Math.max(1, Math.floor(all.length / Math.max(1, quota)));
  const picks = [...new Set([...active, ...all.filter((_, k) => k % step === 0).slice(0, quota)])];

  const report: LookaheadReport = { checked: picks.length, mismatches: [] };
  for (const i of picks) {
    const cut = candles.slice(0, i + 1);
    const ref = o.context?.reference?.filter((c) => c.time <= candles[i].time);
    const a = describe(fullSig.get(i)!);
    const b = describe(s.evaluate(s.prepare(cut, p, { reference: ref }), i, p, o.allowShort, false));
    if (a !== b) report.mismatches.push({ time: candles[i].time, full: a, cut: b });
  }
  return report;
}
