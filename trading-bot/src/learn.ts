import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backtest } from "./backtest.js";
import type { Config } from "./config.js";
import { rateFunction, type FxRates } from "./data/source.js";
import { referenceMarket, STRATEGIES, strategyOf } from "./strategy.js";
import { closedCandles, TIMEFRAME_MS } from "./timeframes.js";
import type { Candle, ClosedTrade, Market, StrategyName, StrategyParams } from "./types.js";

// Walk-forward self-tuning. For each group of markets that share a strategy and timeframe, every
// parameter combination of the strategy's grid is backtested on the older part of the history
// (pooled across the group: per-coin samples are too small to trust). The best one is then judged
// on the most recent part, which the search never saw. It is adopted only if it also wins there;
// if neither it nor the current parameters do, the group is paused: monitored, not traded.

export interface Stats {
  trades: number;
  pnl: number;
  profitFactor: number;
  winRatePct: number;
  /** Distinct UTC days with trades: the number of independent episodes, roughly. */
  days: number;
  /**
   * Mean daily result over its standard error. Trades are grouped by day because one crash can
   * trigger a dozen coins at once: counted per trade, a single day would look like strong evidence.
   */
  tStat: number;
}

export interface LearnedGroup {
  key: string;
  strategy: StrategyName;
  timeframe: string;
  markets: string[];
  /** Parameters adopted for the group (only the tuned keys). */
  params: StrategyParams;
  train: Stats;
  test: Stats;
  /** How the parameters in the configuration did on the same unseen data. */
  currentTest: Stats;
  decision: "nuevos" | "actuales" | "pausa" | "sin muestra";
  note: string;
}

export interface LearnState {
  updatedAt: number;
  from: number;
  split: number;
  to: number;
  groups: LearnedGroup[];
}

export function stats(trades: ClosedTrade[]): Stats {
  const n = trades.length;
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0);
  const gw = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = gw - pnl;
  const byDay = new Map<string, number>();
  for (const t of trades) {
    const day = new Date(t.openedAt).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + t.pnl);
  }
  const daily = [...byDay.values()];
  const d = daily.length;
  const mean = d ? pnl / d : 0;
  const sd = d > 1 ? Math.sqrt(daily.reduce((s, x) => s + (x - mean) ** 2, 0) / (d - 1)) : 0;
  return { trades: n, pnl, profitFactor: gl > 0 ? gw / gl : gw > 0 ? 99 : 0, winRatePct: n ? (wins.length / n) * 100 : 0, days: d, tStat: sd > 0 ? (mean / sd) * Math.sqrt(d) : 0 };
}

/** Every combination of the grid's values. */
export function combinations(grid: Record<string, number[]>): StrategyParams[] {
  return Object.entries(grid).reduce<StrategyParams[]>((acc, [k, values]) => acc.flatMap((c) => values.map((v) => ({ ...c, [k]: v }))), [{}]);
}

/** Fewest distinct trading days that count as evidence, in the search and in the validation. */
const MIN_DAYS = 8;

interface Prepared {
  market: Market;
  candles: Candle[];
  rateAt: (price: number) => number;
}

export interface LearnOptions {
  markets: Market[];
  config: Config;
  fx: FxRates;
  history: (m: Market, since: number) => Promise<Candle[]>;
  now: number;
  log: (msg: string) => void;
}

export async function learn(o: LearnOptions): Promise<LearnState> {
  const { config, now } = o;
  const L = config.learning;
  const groups = new Map<string, Market[]>();
  for (const m of o.markets) {
    const key = `${m.strategyName} ${m.timeframe} ${m.type}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  const state: LearnState = { updatedAt: now, from: Infinity, split: 0, to: now, groups: [] };

  for (const [key, markets] of groups) {
    const step = TIMEFRAME_MS[markets[0].timeframe];
    const span = Math.min(L.bars * step, L.maxDays * 86_400_000);
    const from = now - span;
    const split = now - (span * L.testPct) / 100;
    // Generous warm-up so every combination's indicators are settled when trading starts.
    const warmupBars = 3 * Math.max(...Object.values(strategyOf(markets[0]).grid).flat(), strategyOf(markets[0]).minCandles(markets[0].strategy));
    const loaded = await Promise.all(
      markets.map(async (m): Promise<Prepared | null> => {
        try {
          const candles = closedCandles(await o.history(m, from - warmupBars * step), m.timeframe, now);
          if (candles.length < 500) throw new Error(`solo ${candles.length} velas`);
          return { market: m, candles, rateAt: await rateFunction(m, config.accountCurrency, o.fx, candles.at(-1)!.close) };
        } catch (err) {
          o.log(`Aprendizaje ${m.id}: sin datos (${(err as Error).message})`);
          return null;
        }
      }),
    );
    const data = loaded.filter((d): d is Prepared => d !== null);
    let reference: Candle[] | undefined;
    if (markets[0].type === "crypto") {
      try {
        reference = closedCandles(await o.history(referenceMarket(config.crypto.reference, markets[0]), from - warmupBars * step), markets[0].timeframe, now);
      } catch (err) {
        o.log(`Aprendizaje: sin datos de ${config.crypto.reference} (${(err as Error).message})`);
      }
    }
    if (!data.length) continue;
    state.from = Math.min(state.from, from);
    state.split = split;

    const run = (overrides: StrategyParams, tradeFrom: number, tradeUntil?: number) =>
      stats(
        data.flatMap(({ market, candles, rateAt }) => {
          const m = { ...market, strategy: { ...market.strategy, ...overrides } };
          try {
            return backtest({ market: m, candles, risk: config.risk, costs: config.paper, startingBalance: config.paper.startingBalance, rateAt, tradeFrom, tradeUntil, context: { reference } }).trades;
          } catch {
            return [];
          }
        }),
      );

    const impl = STRATEGIES[markets[0].strategyName];
    const candidates = combinations(impl.grid).filter((c) => !impl.validate({ ...markets[0].strategy, ...c }));
    let best: { params: StrategyParams; train: Stats } | null = null;
    for (const params of candidates) {
      const train = run(params, from, split);
      if (train.trades >= L.minTrades && train.days >= MIN_DAYS && train.pnl > 0 && (!best || train.tStat > best.train.tStat)) best = { params, train };
    }
    const current = Object.fromEntries(Object.keys(impl.grid).map((k) => [k, markets[0].strategy[k]]));
    const currentTest = run({}, split);
    const minTest = Math.max(5, Math.round((L.minTrades * L.testPct) / (100 - L.testPct)));
    const passes = (s: Stats) => s.trades >= minTest && s.days >= MIN_DAYS && s.pnl > 0 && s.profitFactor >= L.minProfitFactor;

    let group: LearnedGroup;
    const base = { key, strategy: markets[0].strategyName, timeframe: markets[0].timeframe, markets: data.map((d) => d.market.id), currentTest };
    if (best) {
      const test = run(best.params, split);
      if (passes(test)) group = { ...base, params: best.params, train: best.train, test, decision: "nuevos", note: "los mejores parámetros del pasado también ganan en datos no vistos" };
      else if (passes(currentTest)) group = { ...base, params: current, train: run({}, from, split), test: currentTest, decision: "actuales", note: "los nuevos no aguantan en datos no vistos; los actuales sí" };
      else if (Math.max(test.days, currentTest.days) < MIN_DAYS || (test.trades < minTest && currentTest.trades < minTest)) {
        group = { ...base, params: current, train: best.train, test, decision: "sin muestra", note: `menos de ${minTest} operaciones o ${MIN_DAYS} días con operaciones para validar` };
      }
      else group = { ...base, params: current, train: best.train, test, decision: "pausa", note: "ninguna configuración gana en datos no vistos" };
    } else {
      const train = run({}, from, split);
      group =
        train.trades < L.minTrades
          ? { ...base, params: current, train, test: currentTest, decision: "sin muestra", note: `menos de ${L.minTrades} operaciones para aprender` }
          : { ...base, params: current, train, test: currentTest, decision: "pausa", note: "ninguna configuración gana ni en el pasado" };
    }
    state.groups.push(group);
  }
  return state;
}

/** Apply learned parameters and pauses to the markets; returns one line per change. */
export function applyLearning(markets: Market[], state: LearnState | null): string[] {
  const lines: string[] = [];
  for (const m of markets) {
    const g = state?.groups.find((x) => x.markets.includes(m.id) && x.strategy === m.strategyName);
    m.paused = undefined;
    if (!g) continue;
    if (g.decision === "nuevos") {
      m.strategy = { ...m.strategy, ...g.params };
      lines.push(`${m.id}: parámetros aprendidos ${JSON.stringify(g.params)}`);
    } else if (g.decision === "pausa") {
      m.paused = g.note;
      lines.push(`${m.id}: en pausa (${g.note})`);
    }
  }
  return lines;
}

const fileOf = (dir: string) => join(dir, "aprendizaje.json");

export function loadLearning(dir: string): LearnState | null {
  return existsSync(fileOf(dir)) ? (JSON.parse(readFileSync(fileOf(dir), "utf8")) as LearnState) : null;
}

/** Save the latest state, and append a summary to the learning journal (one JSON line per run). */
export function saveLearning(dir: string, state: LearnState): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(fileOf(dir), JSON.stringify(state, null, 2));
  const summary = state.groups.map((g) => ({ grupo: g.key, decision: g.decision, params: g.params, train: g.train, test: g.test }));
  appendFileSync(join(dir, "aprendizaje.log"), JSON.stringify({ fecha: new Date(state.updatedAt).toISOString(), grupos: summary }) + "\n");
}

export function describeLearning(state: LearnState, ccy: string): string[] {
  const s = (x: Stats) => `${x.trades} ops en ${x.days} días, PF ${x.profitFactor.toFixed(2)}, aciertos ${x.winRatePct.toFixed(0)}%, ${x.pnl >= 0 ? "+" : ""}${x.pnl.toFixed(0)} ${ccy}`;
  return state.groups.flatMap((g) => [
    `${g.key} (${g.markets.length} mercados) → ${g.decision.toUpperCase()}: ${g.note}`,
    `   parámetros ${JSON.stringify(g.params)}`,
    `   aprendizaje ${s(g.train)} | validación ${s(g.test)} | actuales en validación ${s(g.currentTest)}`,
  ]);
}
