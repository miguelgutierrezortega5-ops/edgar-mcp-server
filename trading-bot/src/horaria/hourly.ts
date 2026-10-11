import type { CandleSource } from "../data/source.js";
import * as fmt from "../fmt.js";
import type { Candle, ClosedTrade, Market } from "../types.js";
import { align, examples, fit, HOUR, rank, WARMUP_HOURS, type Aligned, type ProbabilityModel } from "./model.js";

// Every hour challenge 1 buys the coin most likely to beat its costs over the next hour and sells it at the
// next decision; when the most likely coin is the one it already holds it keeps it another hour (selling and
// buying it back would only pay 0.3% in fees). This class decides; the engine (src/engine.ts) trades in
// challenge 1's own account, so the hourly trade shares its cash and its results.

export interface HorariaConfig {
  enabled: boolean;
  /** USD bought each hour (Binance's minimum order is 5). */
  orderUsd: number;
  /** Days of hourly candles the model learns from. */
  trainDays: number;
  retrainHours: number;
  /** Minutes to wait for a coin's last hourly candle before deciding without it. */
  waitMinutes: number;
}

export type HourAction = "compra" | "mantiene" | "pausa" | "sin dinero" | "sin precio";

export interface HourDecision {
  /** Start of the hour it trades in. */
  hour: number;
  symbol: string;
  p: number;
  action: HourAction;
  /** The chosen coin's move over that hour, once its candle closes. */
  move?: number;
}

export interface HorariaState {
  lastHour: number;
  model?: ProbabilityModel;
  /** The last hour's coins, most likely first. */
  ranking: { symbol: string; p: number }[];
  decisions: HourDecision[];
  trades: ClosedTrade[];
  /** Last UTC day already summarized on Telegram. */
  summarizedDay?: string;
}

export const newHorariaState = (): HorariaState => ({ lastHour: 0, ranking: [], decisions: [], trades: [] });

const DAY = 24 * HOUR;
const MAX_DECISIONS = 400;
const MAX_TRADES = 300;
const pct = (p: number) => `${(p * 100).toFixed(0)}%`;
const coin = (symbol: string) => symbol.split("/")[0];
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Closed hourly candles of `market`'s pair, from `since`. */
export const hourly = (market: Market): Market => ({ ...market, id: `${market.symbol} 1h`, timeframe: "1h" });

export interface HorariaDeps {
  config: HorariaConfig;
  /** Fee plus slippage of a whole round trip, as a fraction. */
  cost: number;
  source: CandleSource;
  /** BTC, the clock of the hourly grid and two of the readings. */
  reference: Market;
  state: HorariaState;
  log: (msg: string) => void;
}

/**
 * Retrains on the `trainDays` before hour index `i` (labels known by then) at the first decision of each
 * `retrainHours` block of UTC time (00:00 for 24 h), so the phone and a replay learn from the same hours.
 */
export function trainIfDue(a: Aligned, i: number, model: ProbabilityModel | undefined, c: HorariaConfig, cost: number, now: number): ProbabilityModel | undefined {
  const block = c.retrainHours * HOUR;
  if (model && Math.floor(now / block) === Math.floor(model.trainedAt / block)) return model;
  const rows = examples(a, i - c.trainDays * 24, i - 1, cost);
  return rows.length >= 500 ? fit(rows, now) : model;
}

export class Horaria {
  private failing = false;

  constructor(private readonly d: HorariaDeps) {}

  get state(): HorariaState {
    return this.d.state;
  }

  /** Whether an hour is waiting for its decision. */
  due(now: number): boolean {
    return Math.floor(now / HOUR) * HOUR > this.state.lastHour;
  }

  /**
   * The ranking for the hour that just started, or undefined when it is not time yet or the candles are
   * not in (it tries again on the next round).
   */
  async decide(now: number, markets: Market[]): Promise<{ hour: number; ranking: { market: Market; p: number }[] } | undefined> {
    if (!this.due(now)) return undefined;
    const hour = Math.floor(now / HOUR) * HOUR;
    const since = hour - (this.d.config.trainDays * 24 + WARMUP_HOURS + 24) * HOUR;
    let sets: Candle[][];
    try {
      sets = await Promise.all([this.d.reference, ...markets].map(async (m) => (await this.d.source.history(hourly(m), since)).filter((c) => c.time + HOUR <= now)));
    } catch (err) {
      if (!this.failing) this.d.log(`Operación horaria: sin velas de 1 h (${(err as Error).message}); lo intento de nuevo en la próxima vuelta`);
      this.failing = true;
      return undefined;
    }
    if (this.failing) this.d.log("Operación horaria: velas de 1 h de nuevo");
    this.failing = false;
    const [btc, ...coins] = sets;
    const last = hour - HOUR;
    if (btc.at(-1)?.time !== last) return undefined;
    const late = markets.filter((_, j) => coins[j].at(-1)?.time !== last);
    if (late.length && now - hour < this.d.config.waitMinutes * 60_000) return undefined;
    const a = align(markets.map((m, j) => ({ symbol: m.symbol, candles: coins[j] })), btc);
    const i = a.times.length - 1;
    const before = this.state.model;
    this.state.model = trainIfDue(a, i, before, this.d.config, this.d.cost, now);
    const model = this.state.model;
    if (model && model !== before) this.d.log(`Operación horaria: modelo reentrenado con ${model.samples} horas-moneda de ${this.d.config.trainDays} días (ganaron tras comisiones el ${pct(model.baseRate)})`);
    // How the earlier choices did, now that their hours closed.
    for (const dec of this.state.decisions.slice(-48)) {
      if (dec.move !== undefined) continue;
      const k = a.times.indexOf(dec.hour);
      const s = a.coins.find((x) => x.symbol === dec.symbol);
      if (k > 0 && s && s.close[k] > 0 && s.close[k - 1] > 0) dec.move = s.close[k] / s.close[k - 1] - 1;
    }
    if (!model) {
      this.d.log("Operación horaria: aún no hay historia suficiente para calcular probabilidades");
      return undefined;
    }
    const bySymbol = new Map(markets.map((m) => [m.symbol, m]));
    const ranking = rank(a, i, model).map((r) => ({ market: bySymbol.get(r.symbol)!, p: r.p }));
    this.state.ranking = ranking.map((r) => ({ symbol: r.market.symbol, p: r.p }));
    return { hour, ranking };
  }

  /** Records what the engine did with the hour; returns the previous day's summary once a day. */
  done(hour: number, symbol: string, p: number, action: HourAction, equity: number | undefined, ccy: string): string | undefined {
    this.state.lastHour = hour;
    this.state.decisions.push({ hour, symbol, p, action });
    if (this.state.decisions.length > MAX_DECISIONS) this.state.decisions.splice(0, this.state.decisions.length - MAX_DECISIONS);
    const yesterday = day(hour - DAY);
    if (this.state.summarizedDay === undefined) this.state.summarizedDay = yesterday; // nothing to sum up on the first day
    if (this.state.summarizedDay >= yesterday) return undefined;
    this.state.summarizedDay = yesterday;
    return this.daySummary(yesterday, equity, ccy);
  }

  closed(t: ClosedTrade): void {
    this.state.trades.push(t);
    if (this.state.trades.length > MAX_TRADES) this.state.trades.splice(0, this.state.trades.length - MAX_TRADES);
  }

  daySummary(d: string, equity: number | undefined, ccy: string): string | undefined {
    const decs = this.state.decisions.filter((x) => day(x.hour) === d);
    if (!decs.length) return undefined;
    const trades = this.state.trades.filter((t) => day(t.openedAt) === d);
    const pnl = trades.reduce((a, t) => a + t.pnl, 0);
    const judged = decs.filter((x) => x.move !== undefined && (x.action === "compra" || x.action === "mantiene"));
    const hit = judged.filter((x) => x.move! > this.d.cost).length;
    const count = (a: HourAction) => decs.filter((x) => x.action === a).length;
    const lines = [`⏱️ Reto 1, operación de cada hora (${d}): ${decs.length} horas, ${count("compra")} compras y ${count("mantiene")} veces se quedó con la misma moneda.`];
    const skipped = decs.length - count("compra") - count("mantiene");
    if (skipped) lines.push(`${skipped} horas sin operar (pausa, sin dinero libre o sin precio).`);
    lines.push(`Operaciones de ese día: ${trades.length}, ${trades.filter((t) => t.pnl > 0).length} con ganancia, resultado ${fmt.money(pnl, ccy)}.`);
    if (judged.length) lines.push(`Probabilidad calculada media ${pct(judged.reduce((a, x) => a + x.p, 0) / judged.length)}; la moneda elegida superó las comisiones en ${hit} de ${judged.length} horas (${pct(hit / judged.length)}).`);
    if (equity !== undefined) lines.push(`Reto 1: ${fmt.money(equity, ccy)}.`);
    return lines.join("\n");
  }

  summary(now: number, ccy: string): string {
    const s = this.state;
    const lines = ["⏱️ Reto 1, operación de cada hora: compra la moneda con más probabilidad de superar las comisiones en la hora siguiente."];
    const last = s.decisions.at(-1);
    if (!last) lines.push("Todavía no decide su primera hora.");
    else {
      const verb = last.action === "compra" ? "compró" : last.action === "mantiene" ? "se quedó con" : `no operó (${last.action}); la más probable era`;
      lines.push(`${fmt.time(last.hour)} UTC: ${verb} ${coin(last.symbol)} (probabilidad ${pct(last.p)}). Siguientes: ${s.ranking.slice(1, 4).map((r) => `${coin(r.symbol)} ${pct(r.p)}`).join(", ")}.`);
    }
    const today = s.trades.filter((t) => day(t.closedAt) === day(now));
    lines.push(`Hoy: ${today.length} operaciones cerradas, ${fmt.money(today.reduce((a, t) => a + t.pnl, 0), ccy)}. Desde que empezó: ${s.trades.length} operaciones, ${fmt.money(s.trades.reduce((a, t) => a + t.pnl, 0), ccy)}.`);
    const judged = s.decisions.filter((x) => x.move !== undefined && (x.action === "compra" || x.action === "mantiene"));
    if (judged.length) lines.push(`Aciertos: la moneda elegida superó las comisiones en ${judged.filter((x) => x.move! > this.d.cost).length} de ${judged.length} horas; la probabilidad calculada media fue ${pct(judged.reduce((a, x) => a + x.p, 0) / judged.length)}.`);
    if (s.model) lines.push(`Modelo: ${s.model.samples} horas-moneda de ${this.d.config.trainDays} días, reentrenado ${fmt.time(s.model.trainedAt)} UTC.`);
    lines.push(`Medido de 2024 a 2026: la elegida gana más seguido que una al azar (37% contra 33%), pero ninguna llega al 50% y cada operación pierde en promedio sus comisiones (−0.3%).`);
    return lines.join("\n");
  }

  report(): object {
    const s = this.state;
    return {
      ultimaHora: s.lastHour ? new Date(s.lastHour).toISOString() : null,
      ranking: s.ranking,
      modelo: s.model ? { entrenado: new Date(s.model.trainedAt).toISOString(), muestras: s.model.samples, tasaBase: s.model.baseRate } : null,
      decisiones: s.decisions.slice(-72),
      operaciones: s.trades.slice(-60),
    };
  }
}

