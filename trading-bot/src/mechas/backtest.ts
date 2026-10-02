import type { FuturesMinutes } from "../data/futures1m.js";
import type { Bar } from "./core.js";
import { MechasBot, type MechasConfig } from "./bot.js";
import type { Pick } from "./universe.js";

// Replays archived 1-minute futures candles through the live bot's own minute step, so the backtest and
// the bot cannot drift apart. The coins are today's selection: on past days that flatters the result a
// little (the walk-forward study in the README chose them with the previous month instead).

export interface MechasBacktest {
  bot: MechasBot;
  minutes: number;
  maxDrawdown: number;
}

export async function backtestMechas(config: MechasConfig, source: FuturesMinutes, coins: Pick[], from: number, to: number, log: (msg: string) => void = () => {}): Promise<MechasBacktest> {
  const MINUTE = 60_000;
  const warm = from - 300 * MINUTE;
  const series = new Map<string, Map<number, Bar>>();
  for (const symbol of [...new Set([...coins.map((c) => c.symbol), ...config.leaders])]) {
    const bars = await source.archive(symbol, warm, to);
    log(`  ${symbol}: ${bars.length} velas de 1 minuto`);
    series.set(symbol, new Map(bars.map((b) => [b.time, b])));
  }
  let t = warm;
  const bot = new MechasBot({ config, source, notify: async () => {}, log: () => {}, now: () => t });
  bot.setCoins(coins, from);
  let peak = config.startingBalance;
  let maxDrawdown = 0;
  for (; t < to; t += MINUTE) {
    for (const [symbol, bars] of series) {
      const b = bars.get(t);
      if (b) bot.addBars(symbol, [b]);
    }
    if (t < from) continue;
    bot.processMinute(t, true);
    peak = Math.max(peak, bot.state.balance);
    maxDrawdown = Math.min(maxDrawdown, bot.state.balance / peak - 1);
  }
  return { bot, minutes: (to - from) / MINUTE, maxDrawdown };
}
