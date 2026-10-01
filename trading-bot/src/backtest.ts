import { unrealized } from "./brokers/broker.js";
import { PaperAccount, paperUnits, type PaperCosts } from "./brokers/paper.js";
import { canOpen, newRiskState, positionSize, updateRisk, type RiskParams } from "./risk.js";
import { checkStops, trailStop } from "./stops.js";
import { computeIndicators, evaluate, minCandles, type Signal } from "./strategy.js";
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
 * the stop assumed first when a bar touches both.
 */
export function backtest(o: BacktestOptions): BacktestResult {
  const { market, candles } = o;
  const p = market.strategy;
  const step = TIMEFRAME_MS[market.timeframe];
  const ind = computeIndicators(candles, p);
  const book = { balance: o.startingBalance, nextId: 1 };
  const account = new PaperAccount(book, o.costs, "backtest");
  const start = candles.findIndex((c) => c.time >= (o.tradeFrom ?? -Infinity));
  const first = start < 0 ? -1 : Math.max(minCandles(p) - 1, start);
  if (first < 0 || first >= candles.length - 1) throw new Error(`${market.id}: historial insuficiente para el backtest (${candles.length} velas)`);

  const risk = newRiskState(o.startingBalance, candles[first].time);
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

  for (let i = first; i < candles.length; i++) {
    const bar = candles[i];
    if (pending) {
      const sig: Signal = pending;
      pending = null;
      if (pos && ((pos.side === "long" && sig.exitLong) || (pos.side === "short" && sig.exitShort))) close("cruce contrario de medias", bar.open, bar.time);
      if (!pos && sig.entry && canOpen(risk, o.risk, book.balance, 0).ok) {
        const rate = o.rateAt(bar.open);
        const units = paperUnits(market, positionSize({ equity: book.balance, price: bar.open, stopDistance: sig.entry.stopDistance, rate, type: market.type, params: o.risk }));
        if (units > 0) {
          pos = account.open({ market, side: sig.entry.side, units, price: bar.open, rate, stopDistance: sig.entry.stopDistance, takeProfitDistance: sig.entry.takeProfitDistance, time: bar.time });
        }
      }
    }

    if (pos) {
      const hit = checkStops(pos, bar);
      if (hit) close(hit.reason, hit.price, bar.time + step);
    }
    if (pos && p.trailingStopAtr > 0) {
      const stop = trailStop(pos, bar, ind.atr[i], p.trailingStopAtr);
      if (stop !== null) (pos as Position).stop = stop;
    }

    if (pos) barsInMarket++;
    const equity = book.balance + (pos ? unrealized(pos, { price: bar.close, rate: o.rateAt(bar.close) }) : 0);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (1 - equity / peak) * 100);
    if (updateRisk(risk, o.risk, equity, bar.time + step) && pos) close("parada por drawdown máximo", bar.close, bar.time + step);

    if (i < candles.length - 1) pending = evaluate(ind, i, p, market.allowShort);
  }
  const last = candles.at(-1)!;
  if (pos) close("fin del backtest", last.close, last.time + step);

  const wins = trades.filter((t) => t.pnl > 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  const bars = candles.length - first;
  return {
    market,
    from: candles[first].time,
    to: last.time + step,
    bars,
    trades,
    startEquity: o.startingBalance,
    endEquity: book.balance,
    returnPct: (book.balance / o.startingBalance - 1) * 100,
    buyHoldPct: (last.close / candles[first].open - 1) * 100,
    maxDrawdownPct: maxDrawdown,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : NaN,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : NaN,
    fees: trades.reduce((s, t) => s + t.fees, 0),
    exposurePct: (barsInMarket / bars) * 100,
    halted: risk.halted,
  };
}
