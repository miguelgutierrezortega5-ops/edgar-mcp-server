import { unrealized } from "./brokers/broker.js";
import { PaperAccount, paperUnits, type PaperCosts } from "./brokers/paper.js";
import { averageBarValue, canOpen, newRiskState, positionSize, updateRisk, type RiskParams } from "./risk.js";
import { checkStops, trailStop } from "./stops.js";
import { minCandles, signals, type Signal } from "./strategy.js";
import type { StrategyContext } from "./strategies/types.js";
import { TIMEFRAME_MS } from "./timeframes.js";
import type { Candle, ClosedTrade, Market, Position } from "./types.js";

export interface BacktestOptions {
  market: Market;
  candles: Candle[];
  risk: RiskParams;
  costs: PaperCosts;
  startingBalance: number;
  /** Quote-to-account rate at a given price of the market. */
  rateAt: (price: number) => number;
  /** Trade only from this time on; earlier bars just warm up the indicators. */
  tradeFrom?: number;
  /** Stop trading at this time (bars after it are ignored). */
  tradeUntil?: number;
  context?: StrategyContext;
}

export interface BacktestResult {
  market: Market;
  from: number;
  to: number;
  bars: number;
  trades: ClosedTrade[];
  startEquity: number;
  endEquity: number;
  returnPct: number;
  buyHoldPct: number;
  maxDrawdownPct: number;
  winRatePct: number;
  profitFactor: number;
  fees: number;
  exposurePct: number;
  halted: string | null;
}

/**
 * Replays the live rules bar by bar: signals are computed at a bar's close and executed at the
 * next bar's open; stops and take-profits fill at their level (or at the open on a gap), with
 * the stop assumed first when a bar touches both; time stops close at the bar's close.
 */
export function backtest(o: BacktestOptions): BacktestResult {
  const { market } = o;
  const { candles } = o;
  // Keep the same array (its indicators are cached across runs) and stop the replay at tradeUntil.
  const endIdx = o.tradeUntil === undefined ? candles.length : candles.findIndex((c) => c.time >= o.tradeUntil!);
  const end = endIdx < 0 ? candles.length : endIdx;
  const p = market.strategy;
  const step = TIMEFRAME_MS[market.timeframe];
  const book = { balance: o.startingBalance, nextId: 1 };
  const account = new PaperAccount(book, o.costs, "backtest");
  const start = candles.findIndex((c) => c.time >= (o.tradeFrom ?? -Infinity));
  const first = start < 0 ? -1 : Math.max(minCandles(market) - 1, start);
  if (first < 0 || first >= end - 1) throw new Error(`${market.id}: historial insuficiente para el backtest (${candles.length} velas)`);
  const sigs = signals(market, candles, first, o.context, end);
  const replay = candles.slice(0, end);

  const risk = newRiskState(o.startingBalance, replay[first].time);
  const trades: ClosedTrade[] = [];
  let pos: Position | null = null;
  let pending: Signal | null = null;
  let peak = o.startingBalance;
  let maxDrawdown = 0;
  let barsInMarket = 0;
  const close = (reason: string, price: number, time: number) => {
    trades.push(account.close(pos!, { market, reason, price, rate: o.rateAt(price), time }));
    pos = null;
  };

  for (let i = first; i < replay.length; i++) {
    const bar = replay[i];
    if (pending) {
      const sig: Signal = pending;
      pending = null;
      if (pos && ((pos.side === "long" && sig.exitLong) || (pos.side === "short" && sig.exitShort))) close("señal de salida", bar.open, bar.time);
      if (!pos && sig.entry && canOpen(risk, o.risk, book.balance, 0).ok) {
        const rate = o.rateAt(bar.open);
        const size = positionSize({
          equity: book.balance,
          price: bar.open,
          stopDistance: sig.entry.stopDistance,
          rate,
          type: market.type,
          params: o.risk,
          barValue: averageBarValue(replay.slice(Math.max(0, i - 50), i)),
        });
        const units = paperUnits(market, size);
        if (units > 0) {
          const opened = account.open({ market, side: sig.entry.side, units, price: bar.open, rate, stopDistance: sig.entry.stopDistance, takeProfitDistance: sig.entry.takeProfitDistance, time: bar.time });
          if (sig.entry.maxBars) opened.expiresAt = bar.time + sig.entry.maxBars * step;
          pos = opened;
        }
      }
    }

    if (pos) {
      const hit = checkStops(pos, bar);
      if (hit) close(hit.reason, hit.price, bar.time + step);
    }
    if (pos && (pos as Position).expiresAt !== undefined && bar.time + step >= (pos as Position).expiresAt!) close("tiempo máximo", bar.close, bar.time + step);
    if (pos && p.trailingStopAtr > 0) {
      const stop = trailStop(pos, bar, sigs[i]?.atr ?? NaN, p.trailingStopAtr);
      if (stop !== null) (pos as Position).stop = stop;
    }

    if (pos) barsInMarket++;
    const equity = book.balance + (pos ? unrealized(pos, { price: bar.close, rate: o.rateAt(bar.close) }) : 0);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (1 - equity / peak) * 100);
    if (updateRisk(risk, o.risk, equity, bar.time + step) && pos) close("parada por drawdown máximo", bar.close, bar.time + step);

    if (i < replay.length - 1) pending = sigs[i];
  }
  const last = replay.at(-1)!;
  if (pos) close("fin del backtest", last.close, last.time + step);

  const wins = trades.filter((t) => t.pnl > 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  const bars = replay.length - first;
  return {
    market,
    from: replay[first].time,
    to: last.time + step,
    bars,
    trades,
    startEquity: o.startingBalance,
    endEquity: book.balance,
    returnPct: (book.balance / o.startingBalance - 1) * 100,
    buyHoldPct: (last.close / replay[first].open - 1) * 100,
    maxDrawdownPct: maxDrawdown,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : NaN,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : NaN,
    fees: trades.reduce((s, t) => s + t.fees, 0),
    exposurePct: (barsInMarket / bars) * 100,
    halted: risk.halted,
  };
}
