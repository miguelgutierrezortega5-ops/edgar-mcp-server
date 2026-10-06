import { TendenciaBot, type DailySource, type TendenciaConfig, type TrendTrade } from "./bot.js";
import { TrendModel, type DayBar, type TrendView } from "./core.js";

// Replays daily candles through the live bot's own daily step: decisions at each close, orders at the
// next day's open, the account valued at each close. The trend models start well before `from`, so the
// first day already knows which coins were trending.

const DAY = 86_400_000;
const WARMUP_DAYS = 1100;

export interface TendenciaBacktest {
  bot: TendenciaBot;
  /** Account value at each close from the first trading day. */
  equity: { day: number; value: number }[];
  /** BTC bought at the same first open and held, scaled to the same starting balance. */
  btc: { day: number; value: number }[];
  /** Every order (the bot keeps only the latest). */
  trades: TrendTrade[];
}

export async function backtestTendencia(config: TendenciaConfig, source: DailySource, from: number, to: number, log: (msg: string) => void = () => {}): Promise<TendenciaBacktest> {
  let now = from;
  const bot = new TendenciaBot({ config, source, notify: async () => {}, log: () => {}, now: () => now });
  const series = new Map<string, Map<number, DayBar>>();
  for (const symbol of [...new Set([...bot.symbols, `BTC${config.quote}`])]) {
    const bars = (await source.days(symbol, from - WARMUP_DAYS * DAY)).filter((b) => b.time + DAY <= Date.now());
    log(`  ${symbol}: ${bars.length} velas diarias`);
    series.set(symbol, new Map(bars.map((b) => [b.time, b])));
  }
  const models = new Map(bot.symbols.map((s) => [s, new TrendModel(config.lookbacks)]));
  const equity: TendenciaBacktest["equity"] = [];
  const btc: TendenciaBacktest["btc"] = [];
  const btcBars = series.get(`BTC${config.quote}`)!;
  let btcUnits = 0;
  const trades: TrendTrade[] = [];
  for (let t = from - WARMUP_DAYS * DAY; t + DAY < to; t += DAY) {
    for (const [s, m] of models) {
      const b = series.get(s)!.get(t);
      if (b) m.add(b.close);
    }
    if (t < from) continue;
    const next = t + DAY;
    const views: Record<string, TrendView> = {};
    const opens: Record<string, number> = {};
    for (const [s, m] of models) {
      const nb = series.get(s)!.get(next);
      if (!series.get(s)!.get(t) || !nb) continue; // not listed yet (or gone): no opinion, no orders
      views[s] = m.view();
      opens[s] = nb.open;
    }
    now = next;
    trades.push(...bot.step(t, views, opens, next));
    const closes = Object.fromEntries([...series].map(([s, m]) => [s, m.get(next)?.close ?? bot.state.prices[s] ?? 0]));
    bot.state.prices = closes; // valued at the close, as the live bot sees it later in the day
    equity.push({ day: next, value: bot.value() });
    const bb = btcBars.get(next);
    if (bb) {
      if (!btcUnits) btcUnits = config.startingBalance / bb.open;
      btc.push({ day: next, value: btcUnits * bb.close });
    }
  }
  return { bot, equity, btc, trades };
}
