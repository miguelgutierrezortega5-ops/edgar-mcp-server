import type { CandleSource } from "../data/source.js";
import type { Market } from "../types.js";
import { hourly, trainIfDue, type HorariaConfig } from "./hourly.js";
import { align, HOUR, rank, WARMUP_HOURS, type ProbabilityModel } from "./model.js";

// Replays the hourly trade with the live code's model and choice: at each hour's start it ranks the coins on
// the closed candles, buys the most likely one at the last close (or keeps it) and sells the previous one.

export interface HourlyReplay {
  hours: { hour: number; symbol: string; p: number; kept: boolean; move?: number; /** Share of all the coins that beat the cost that hour (a random pick's odds). */ beat?: number }[];
  trades: { symbol: string; openedAt: number; closedAt: number; entry: number; exit: number; pnl: number }[];
}

export async function backtestHoraria(config: HorariaConfig, costs: { feePct: number; slippagePct: number }, source: CandleSource, markets: Market[], reference: Market, from: number, to: number, log: (msg: string) => void = () => {}): Promise<HourlyReplay> {
  const since = from - (config.trainDays * 24 + WARMUP_HOURS + 24) * HOUR;
  const until = Math.min(to, Date.now());
  const load = async (m: Market) => (await source.history(hourly(m), since)).filter((c) => c.time + HOUR <= until);
  const btc = await load(reference);
  const coins = [];
  for (const m of markets) coins.push({ symbol: m.symbol, candles: await load(m) });
  log(`  ${coins.length} monedas y ${reference.base}: ${btc.length} velas de 1 h`);
  const a = align(coins, btc);
  const fee = costs.feePct / 100;
  const slip = costs.slippagePct / 100;
  const cost = 2 * (fee + slip);
  const out: HourlyReplay = { hours: [], trades: [] };
  let model: ProbabilityModel | undefined;
  let held: { j: number; units: number; paid: number; entry: number; openedAt: number } | undefined;
  const sell = (i: number) => {
    if (!held) return;
    const exit = a.coins[held.j].close[i] * (1 - slip);
    const value = held.units * exit;
    out.trades.push({ symbol: a.coins[held.j].symbol, openedAt: held.openedAt, closedAt: a.times[i] + HOUR, entry: held.entry, exit, pnl: value * (1 - fee) - held.paid });
    held = undefined;
  };
  for (let i = 0; i < a.times.length; i++) {
    const hour = a.times[i] + HOUR;
    if (hour < from || hour >= to) continue;
    model = trainIfDue(a, i, model, config, cost, hour);
    if (!model) continue;
    const best = rank(a, i, model)[0];
    if (!best) continue;
    const j = a.coins.findIndex((c) => c.symbol === best.symbol);
    const kept = held?.j === j;
    if (!kept) {
      sell(i);
      const entry = a.coins[j].close[i] * (1 + slip);
      const units = (config.orderUsd * 1.001) / entry;
      held = { j, units, paid: units * entry * (1 + fee), entry, openedAt: hour };
    }
    const moves = a.coins.map((c) => (c.close[i + 1] > 0 && c.close[i] > 0 ? c.close[i + 1] / c.close[i] - 1 : NaN)).filter(Number.isFinite);
    const move = a.coins[j].close[i + 1] / a.coins[j].close[i] - 1;
    out.hours.push({ hour, symbol: best.symbol, p: best.p, kept, move: Number.isFinite(move) ? move : undefined, beat: moves.length ? moves.filter((m) => m > cost).length / moves.length : undefined });
  }
  const last = a.times.length - 1;
  if (held && a.coins[held.j].close[last] > 0) sell(last);
  return out;
}
