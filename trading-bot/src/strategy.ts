import { capitulation } from "./strategies/capitulation.js";
import { emaCross } from "./strategies/ema.js";
import type { Signal, Strategy, StrategyContext } from "./strategies/types.js";
import type { Candle, Market, StrategyName } from "./types.js";

export type { Entry, Signal, Strategy, StrategyContext } from "./strategies/types.js";

export const STRATEGIES: Record<StrategyName, Strategy> = {
  cruce_medias: emaCross,
  capitulacion: capitulation,
};

export function strategyOf(m: Pick<Market, "strategyName">): Strategy {
  return STRATEGIES[m.strategyName];
}

export function minCandles(m: Pick<Market, "strategyName" | "strategy">): number {
  return strategyOf(m).minCandles(m.strategy);
}

// The learner backtests hundreds of parameter sets on the same bars; indicator series depend only on
// a few parameters, so they are computed once per series and reused.
const prepared = new WeakMap<Candle[], Map<string, unknown>>();

function prepareCached(s: Strategy, candles: Candle[], p: Market["strategy"], ctx?: StrategyContext): unknown {
  const key = `${s.name}|${s.prepareKeys.map((k) => p[k]).join(",")}|${ctx?.reference?.length ?? 0}:${ctx?.reference?.at(-1)?.time ?? 0}`;
  let cache = prepared.get(candles);
  if (!cache) prepared.set(candles, (cache = new Map()));
  if (!cache.has(key)) cache.set(key, s.prepare(candles, p, ctx));
  return cache.get(key);
}

/** Signals for every bar of a series (index-aligned); used by the backtester and the learner. */
export function signals(m: Pick<Market, "strategyName" | "strategy" | "allowShort">, candles: Candle[], from = 0, ctx?: StrategyContext, to = candles.length): (Signal | null)[] {
  const s = strategyOf(m);
  const prep = prepareCached(s, candles, m.strategy, ctx);
  return candles.map((_, i) => (i < from || i >= to ? null : s.evaluate(prep, i, m.strategy, m.allowShort, false)));
}

/** Signal at the close of the last bar. */
export function signalAt(m: Pick<Market, "strategyName" | "strategy" | "allowShort">, candles: Candle[], ctx?: StrategyContext): Signal {
  const s = strategyOf(m);
  return s.evaluate(s.prepare(candles, m.strategy, ctx), candles.length - 1, m.strategy, m.allowShort);
}

/** Does this market need the reference market's bars? */
export function needsReference(m: Pick<Market, "strategyName" | "strategy" | "type">): boolean {
  return m.type === "crypto" && Boolean(strategyOf(m).needsReference?.(m.strategy));
}

/** A market object for the reference symbol at `m`'s timeframe (data only, never traded). */
export function referenceMarket(symbol: string, m: Pick<Market, "timeframe">): Market {
  const [base, quote] = symbol.split("/");
  return { id: `${symbol} ${m.timeframe}`, type: "crypto", symbol, base, quote, timeframe: m.timeframe, allowShort: false, strategyName: "cruce_medias", strategy: {} };
}
