import { unrealized } from "./brokers/broker.js";
import { PaperAccount, paperUnits, type PaperCosts } from "./brokers/paper.js";
import { blocked, newProtectionState, onClose, type ProtectionParams } from "./protections.js";
import { averageBarValue, canOpen, newRiskState, positionSize, updateRisk, type RiskParams } from "./risk.js";
import { checkStops, trailStop } from "./stops.js";
import { minCandles, signals, type Signal } from "./strategy.js";
import type { StrategyContext } from "./strategies/types.js";
import { TIMEFRAME_MS } from "./timeframes.js";
import type { Candle, ClosedTrade, Market, Position } from "./types.js";

export interface SeriesInput {
  market: Market;
  candles: Candle[];
  /** Quote-to-account rate at a given price of the market. */
  rateAt: (price: number) => number;
  context?: StrategyContext;
}

export interface PortfolioOptions {
  series: SeriesInput[];
  risk: RiskParams;
  costs: PaperCosts;
  startingBalance: number;
  /** Trade only from this time on; earlier bars just warm up the indicators. */
  tradeFrom?: number;
  /** Stop trading at this time (bars after it are ignored). */
  tradeUntil?: number;
  protections?: ProtectionParams;
}

export interface MarketSummary {
  market: Market;
  trades: ClosedTrade[];
  from: number;
  to: number;
  bars: number;
  exposurePct: number;
  buyHoldPct: number;
}

export interface PortfolioResult {
  trades: ClosedTrade[];
  markets: MarketSummary[];
  from: number;
  to: number;
  startEquity: number;
  endEquity: number;
  returnPct: number;
  maxDrawdownPct: number;
  winRatePct: number;
  profitFactor: number;
  fees: number;
  halted: string | null;
  /** Entries skipped because of the open-position limit or the protections. */
  skipped: number;
}

// Bars of all series merged by time, computed once per set of series (the learner replays it hundreds of times).
const timelines = new WeakMap<Candle[], { key: string; steps: [number, number][][] }>();

function timeline(series: SeriesInput[]): [number, number][][] {
  const key = series.map((s) => `${s.market.id}:${s.candles.length}`).join("|");
  const hit = timelines.get(series[0].candles);
  if (hit && hit.key === key) return hit.steps;
  const byTime = new Map<number, [number, number][]>();
  series.forEach((s, k) => s.candles.forEach((c, i) => (byTime.get(c.time) ?? byTime.set(c.time, []).get(c.time)!).push([k, i])));
  const steps = [...byTime.keys()].sort((a, b) => a - b).map((t) => byTime.get(t)!);
  timelines.set(series[0].candles, { key, steps });
  return steps;
}

/**
 * Replays the live rules on several markets at once with one shared account, as the paper broker
 * does: the open-position limit, the risk limits and the protections apply across markets, so a
 * crash that fires a dozen coins at once is traded only up to the limits. Signals are computed at
 * a bar's close and executed at the next bar's open; stops and take-profits fill at their level (or
 * at the open on a gap), the stop first when a bar touches both; time stops close at the bar's close.
 */
export function simulate(o: PortfolioOptions): PortfolioResult {
  const book = { balance: o.startingBalance, nextId: 1 };
  const account = new PaperAccount(book, o.costs, "backtest");
  const prot = newProtectionState();
  const S = o.series.map((s) => {
    const { candles, market } = s;
    const endIdx = o.tradeUntil === undefined ? candles.length : candles.findIndex((c) => c.time >= o.tradeUntil!);
    const end = endIdx < 0 ? candles.length : endIdx;
    const start = candles.findIndex((c) => c.time >= (o.tradeFrom ?? -Infinity));
    const first = start < 0 ? -1 : Math.max(minCandles(market) - 1, start);
    const ok = first >= 0 && first < end - 1;
    return {
      ...s,
      step: TIMEFRAME_MS[market.timeframe],
      first,
      end,
      ok,
      sigs: ok ? signals(market, candles, first, s.context, end) : [],
      pos: null as Position | null,
      pending: null as Signal | null,
      lastClose: NaN,
      trades: [] as ClosedTrade[],
      inMarket: 0,
    };
  });
  const live = S.filter((s) => s.ok);
  if (!live.length) throw new Error(`historial insuficiente para el backtest (${o.series.map((s) => `${s.market.id}: ${s.candles.length} velas`).join(", ")})`);
  const t0 = Math.min(...live.map((s) => s.candles[s.first].time));
  const risk = newRiskState(o.startingBalance, t0);
  const trades: ClosedTrade[] = [];
  let peak = o.startingBalance;
  let maxDrawdown = 0;
  let skipped = 0;
  let open = 0;

  const close = (s: (typeof S)[number], reason: string, price: number, time: number) => {
    const t = account.close(s.pos!, { market: s.market, reason, price, rate: s.rateAt(price), time });
    trades.push(t);
    s.trades.push(t);
    s.pos = null;
    open--;
    if (o.protections) onClose(prot, o.protections, s.market.id, reason, time, s.step);
  };
  const equity = () => S.reduce((sum, s) => sum + (s.pos ? unrealized(s.pos, { price: s.lastClose, rate: s.rateAt(s.lastClose) }) : 0), book.balance);

  let now = t0;
  for (const step of timeline(o.series)) {
    for (const [k, i] of step) {
      const s = S[k];
      if (!s.ok || i < s.first || i >= s.end) continue;
      const bar = s.candles[i];
      now = bar.time;
      if (s.pending) {
        const sig: Signal = s.pending;
        s.pending = null;
        if (s.pos && ((s.pos.side === "long" && sig.exitLong) || (s.pos.side === "short" && sig.exitShort))) close(s, "señal de salida", bar.open, bar.time);
        if (!s.pos && sig.entry) {
          const eq = equity();
          if (!canOpen(risk, o.risk, eq, open).ok || (o.protections && blocked(prot, s.market.id, bar.time))) skipped++;
          else {
            const rate = s.rateAt(bar.open);
            const size = positionSize({
              equity: eq,
              price: bar.open,
              stopDistance: sig.entry.stopDistance,
              rate,
              type: s.market.type,
              params: o.risk,
              barValue: averageBarValue(s.candles.slice(Math.max(0, i - 50), i)),
            });
            const units = paperUnits(s.market, size);
            if (units > 0) {
              const p = account.open({ market: s.market, side: sig.entry.side, units, price: bar.open, rate, stopDistance: sig.entry.stopDistance, takeProfitDistance: sig.entry.takeProfitDistance, time: bar.time });
              if (sig.entry.maxBars) p.expiresAt = bar.time + sig.entry.maxBars * s.step;
              s.pos = p;
              open++;
            }
          }
        }
      }
      if (s.pos) {
        const hit = checkStops(s.pos, bar);
        if (hit) close(s, hit.reason, hit.price, bar.time + s.step);
      }
      if (s.pos?.expiresAt !== undefined && bar.time + s.step >= s.pos.expiresAt) close(s, "tiempo máximo", bar.close, bar.time + s.step);
      if (s.pos && s.market.strategy.trailingStopAtr > 0) {
        const stop = trailStop(s.pos, bar, s.sigs[i]?.atr ?? NaN, s.market.strategy.trailingStopAtr);
        if (stop !== null) s.pos.stop = stop;
      }
      if (s.pos) s.inMarket++;
      s.lastClose = bar.close;
      if (i < s.end - 1) s.pending = s.sigs[i];
    }
    const eq = equity();
    peak = Math.max(peak, eq);
    maxDrawdown = Math.max(maxDrawdown, (1 - eq / peak) * 100);
    if (updateRisk(risk, o.risk, eq, now)) for (const s of S) if (s.pos) close(s, "parada por drawdown máximo", s.lastClose, now);
  }
  for (const s of S) if (s.pos) close(s, "fin del backtest", s.lastClose, s.candles[s.end - 1].time + s.step);

  const wins = trades.filter((t) => t.pnl > 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  const markets = live.map((s) => ({
    market: s.market,
    trades: s.trades,
    from: s.candles[s.first].time,
    to: s.candles[s.end - 1].time + s.step,
    bars: s.end - s.first,
    exposurePct: (s.inMarket / (s.end - s.first)) * 100,
    buyHoldPct: (s.candles[s.end - 1].close / s.candles[s.first].open - 1) * 100,
  }));
  return {
    trades,
    markets,
    from: t0,
    to: Math.max(...markets.map((m) => m.to)),
    startEquity: o.startingBalance,
    endEquity: book.balance,
    returnPct: (book.balance / o.startingBalance - 1) * 100,
    maxDrawdownPct: maxDrawdown,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : NaN,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : NaN,
    fees: trades.reduce((a, t) => a + t.fees, 0),
    halted: risk.halted,
    skipped,
  };
}

export interface BacktestOptions extends Omit<PortfolioOptions, "series">, SeriesInput {}

export interface BacktestResult extends Omit<PortfolioResult, "markets"> {
  market: Market;
  bars: number;
  buyHoldPct: number;
  exposurePct: number;
}

/** One market alone with its own account. */
export function backtest(o: BacktestOptions): BacktestResult {
  const { market, candles, rateAt, context, ...rest } = o;
  let r: PortfolioResult;
  try {
    r = simulate({ ...rest, series: [{ market, candles, rateAt, context }] });
  } catch {
    throw new Error(`${market.id}: historial insuficiente para el backtest (${candles.length} velas)`);
  }
  const { markets, ...totals } = r;
  return { ...totals, market, bars: markets[0].bars, buyHoldPct: markets[0].buyHoldPct, exposurePct: markets[0].exposurePct, from: markets[0].from, to: markets[0].to };
}
