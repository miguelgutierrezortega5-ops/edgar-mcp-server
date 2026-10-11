import type { Broker } from "./brokers/broker.js";
import type { Config } from "./config.js";
import { quoteRate, type CandleSource, type FxRates } from "./data/source.js";
import * as fmt from "./fmt.js";
import type { Command, Notifier } from "./notify.js";
import { contexts, describeArm, scaleFor, type AdaptiveState } from "./adaptive.js";
import type { FuturesPoint } from "./data/futures.js";
import { committedCash } from "./brokers/paper.js";
import type { HourAction, Horaria } from "./horaria/hourly.js";
import { blocked, onClose } from "./protections.js";
import { averageBarValue, canOpen, newRiskState, positionSize, updateRisk } from "./risk.js";
import { checkStops, trailStop, type Bar } from "./stops.js";
import { paperName, type BotState, type Store } from "./store.js";
import { minCandles, needsReference, referenceMarket, signalAt, type Entry, type Signal } from "./strategy.js";
import { closedCandles, mergeCandles, TIMEFRAME_MS } from "./timeframes.js";
import type { AssetClass, Candle, ClosedTrade, Market, Position, PriceMark } from "./types.js";

export interface BotDeps {
  config: Config;
  markets: Market[];
  sources: Partial<Record<AssetClass, CandleSource>>;
  brokers: Partial<Record<AssetClass, Broker>>;
  fx: FxRates;
  store: Store;
  state: BotState;
  notify: Notifier;
  log: (msg: string) => void;
  now?: () => number;
  /** Runs before each round (the learner hooks in here). */
  beforeTick?: () => Promise<void>;
  /** Pending remote commands (Telegram). */
  commands?: () => Promise<Command[]>;
  /** Handles commands the engine does not know (e.g. /actualizar); undefined = unknown command. */
  onCommand?: (c: Command) => Promise<string | undefined>;
  /** Latest adaptive evidence; null or absent = static rules only. */
  adaptive?: () => AdaptiveState | null;
  /** Binance futures positioning of a market since a time (absent when not available). */
  futures?: (m: Market, since: number) => Promise<FuturesPoint[]>;
  /** Challenge 1's hourly trade (absent = off). */
  hourly?: Horaria;
}

export const COMMAND_HELP = "/estado — saldo, posiciones y pausas\n/pausa — no abrir operaciones nuevas\n/reanudar — quitar pausas y paradas por pérdidas\n/cerrar SIMBOLO|todo — cerrar a mercado\n/mechas — reto 2, cazador de mechas\n/tendencia — reto 3, seguir tendencias\n/horaria — reto 1, la operación de cada hora\n/actualizar — instalar las mejoras nuevas del bot\n/informe — publicar el informe detallado para Claude\n/ayuda";

const MAX_RECENT_TRADES = 100;

/** Initial history to request so that `bars` bars arrive (forex has no weekend bars). */
export function historyStart(market: Market, bars: number, now: number): number {
  return now - Math.ceil(bars * (market.type === "forex" ? 1.5 : 1.05)) * TIMEFRAME_MS[market.timeframe];
}

export class Bot {
  private readonly candles = new Map<string, Candle[]>();
  private readonly references = new Map<string, Candle[]>();
  private lastHeartbeat = 0;
  private readonly marks = new Map<string, PriceMark>();
  private readonly equity = new Map<string, number>();
  private readonly errors = new Map<string, number>();
  private marketById: Map<string, Market>;
  private readonly now: () => number;

  constructor(private readonly d: BotDeps) {
    this.now = d.now ?? Date.now;
    this.marketById = new Map(d.markets.map((m) => [m.id, m]));
  }

  /** Markets currently watched (the list changes with automatic pairs). */
  get markets(): Market[] {
    return this.d.markets;
  }

  private get state(): BotState {
    return this.d.state;
  }

  private broker(m: Market): Broker {
    const b = this.d.brokers[m.type];
    if (!b) throw new Error(`Sin broker para ${m.type}`);
    return b;
  }

  /** Brokers in use, each with the markets it trades. */
  private brokerGroups(): [Broker, Market[]][] {
    const groups = new Map<Broker, Market[]>();
    for (const m of this.d.markets) {
      const b = this.broker(m);
      groups.set(b, [...(groups.get(b) ?? []), m]);
    }
    return [...groups];
  }

  async init(): Promise<void> {
    for (const [broker, markets] of this.brokerGroups()) await broker.init(markets);
    const brokerNames = new Set(this.brokerGroups().map(([b]) => b.name));
    for (const p of this.state.positions) {
      if (!this.marketById.has(p.marketId) || !brokerNames.has(p.broker)) {
        this.d.log(`Aviso: la posición ${p.id} (${p.marketId}, ${p.broker}) no corresponde a la configuración actual y no se gestionará.`);
      }
    }
  }

  /** Fetch only the bars missing since the last call, and keep `historyBars` of them. */
  async refresh(m: Market): Promise<Candle[]> {
    const source = this.d.sources[m.type];
    if (!source) throw new Error(`Sin fuente de datos para ${m.type}`);
    const max = this.d.config.historyBars;
    const buffer = this.candles.get(m.id);
    const since = buffer && buffer.length >= 2 ? buffer[buffer.length - 2].time : historyStart(m, max, this.now());
    const fresh = await source.history(m, since);
    const merged = buffer ? mergeCandles(buffer, fresh, max) : fresh.slice(-max);
    this.candles.set(m.id, merged);
    return merged;
  }

  /** Replace the market list (dynamic pairs); markets with open positions stay until they close. */
  async setMarkets(markets: Market[]): Promise<string[]> {
    const ids = new Set(markets.map((m) => m.id));
    const keep = this.d.markets.filter((m) => !ids.has(m.id) && this.state.positions.some((p) => p.marketId === m.id));
    const next = [...markets, ...keep];
    const added = next.filter((m) => !this.marketById.has(m.id)).map((m) => m.id);
    const removed = this.d.markets.filter((m) => !next.some((x) => x.id === m.id)).map((m) => m.id);
    this.d.markets = next;
    this.marketById = new Map(next.map((m) => [m.id, m]));
    if (added.length) for (const [broker, ms] of this.brokerGroups()) await broker.init(ms);
    return [...added.map((id) => `+ ${id}`), ...removed.map((id) => `- ${id}`)];
  }

  private async handleCommands(now: number): Promise<void> {
    for (const c of (await this.d.commands?.()) ?? []) {
      let reply: string;
      if (c.name === "pausa") {
        this.state.manualPause = true;
        reply = "⏸️ Pausa manual: no abriré operaciones nuevas. Las abiertas siguen gestionadas. /reanudar para seguir.";
      } else if (c.name === "reanudar") {
        this.state.manualPause = false;
        this.state.protections.pausedUntil = 0;
        for (const r of Object.values(this.state.risk)) {
          r.halted = null;
          r.peakEquity = 0;
        }
        reply = "▶️ Trading reanudado.";
      } else if (c.name === "cerrar") {
        const target = (c.args[0] ?? "").toUpperCase();
        const hits = this.state.positions.filter((p) => target === "TODO" || p.symbol === target || p.symbol.split("/")[0] === target);
        for (const p of hits) {
          const m = this.marketById.get(p.marketId);
          const mark = this.marks.get(p.marketId);
          if (m && mark) await this.closePosition(p, m, "cierre manual (Telegram)", mark.price, now);
        }
        reply = hits.length ? `Cerradas ${hits.length} posiciones.` : `No hay posiciones en ${target || "(falta el símbolo)"}.`;
      } else if (c.name === "estado") reply = this.summary(now);
      else reply = (await this.d.onCommand?.(c)) ?? COMMAND_HELP;
      this.d.log(`Telegram /${c.name}: ${reply.split("\n")[0]}`);
      await this.d.notify(reply);
    }
  }

  summary(now: number): string {
    const ccy = this.d.config.accountCurrency;
    const lines = [...this.equity].map(([name, v]) => `💰 ${name}: ${fmt.money(v, ccy)}`);
    for (const p of this.state.positions) {
      const mark = this.marks.get(p.marketId);
      const change = mark ? ((mark.price - p.entryPrice) / p.entryPrice) * 100 * (p.side === "long" ? 1 : -1) : NaN;
      lines.push(p.kind === "horaria" ? `• ${p.symbol} ${fmt.side(p.side)} ${fmt.pct(change)} (operación de cada hora, se revisa en la próxima hora)` : `• ${p.symbol} ${fmt.side(p.side)} ${fmt.pct(change)} (stop ${fmt.price(p.stop)})`);
    }
    if (!this.state.positions.length) lines.push("Sin posiciones abiertas.");
    const day = new Date(now).toISOString().slice(0, 10);
    const today = this.state.recentTrades.filter((t) => new Date(t.closedAt).toISOString().startsWith(day));
    lines.push(`Hoy: ${today.length} operaciones cerradas, ${fmt.money(today.reduce((a, t) => a + t.pnl, 0), ccy)}`);
    const paused = this.d.markets.filter((m) => m.paused).length;
    lines.push(`${this.d.markets.length} mercados vigilados, ${paused} en pausa por el aprendizaje.`);
    if (this.state.manualPause) lines.push("⏸️ Pausa manual activa.");
    if (now < this.state.protections.pausedUntil) lines.push(`🛡️ Pausa por racha de stop-loss hasta ${fmt.time(this.state.protections.pausedUntil)} UTC.`);
    for (const [name, r] of Object.entries(this.state.risk)) if (r.halted) lines.push(`⛔ ${name}: ${r.halted}`);
    return lines.join("\n");
  }

  async tick(): Promise<void> {
    const now = this.now();
    const fresh = new Map<string, Candle[]>();
    // Reference market (BTC) per timeframe, for strategies that compare against the whole market.
    const refs = new Map<string, Market>();
    for (const m of this.d.markets) if (needsReference(m)) refs.set(m.timeframe, referenceMarket(this.d.config.crypto.reference, m));
    for (const [tf, ref] of refs) {
      try {
        this.references.set(tf, closedCandles(await this.refresh(ref), ref.timeframe, now));
        this.recovered(ref.id);
      } catch (err) {
        this.references.delete(tf);
        await this.fail(ref.id, err);
      }
    }
    for (const m of this.d.markets) {
      try {
        const candles = await this.refresh(m);
        const last = candles.at(-1);
        if (!last) throw new Error("la fuente no devolvió velas");
        this.marks.set(m.id, { price: last.close, rate: await quoteRate(m, last.close, this.d.config.accountCurrency, this.d.fx) });
        fresh.set(m.id, candles);
      } catch (err) {
        this.marks.delete(m.id); // a stale price would misvalue the account
        await this.fail(m.id, err);
      }
    }

    for (const [broker, markets] of this.brokerGroups()) {
      try {
        await this.checkAccount(broker, markets, now);
      } catch (err) {
        this.equity.delete(broker.name);
        await this.fail(broker.name, err);
      }
    }

    try {
      await this.handleCommands(now);
    } catch (err) {
      await this.fail("telegram", err);
    }

    for (const m of this.d.markets) {
      const candles = fresh.get(m.id);
      if (!candles) continue;
      try {
        await this.processMarket(m, candles, now);
        this.recovered(m.id);
      } catch (err) {
        await this.fail(m.id, err);
      }
    }
    if (this.d.hourly?.due(now)) {
      try {
        await this.hourlyRound(this.d.hourly, now);
        this.recovered("operación horaria");
      } catch (err) {
        await this.fail("operación horaria", err);
      }
    }
    this.d.store.save(this.state);
    if (now - this.lastHeartbeat >= 15 * 60_000) {
      this.lastHeartbeat = now;
      const value = [...this.equity].map(([name, v]) => `${name} ${fmt.money(v, this.d.config.accountCurrency)}`).join(", ");
      const paused = this.d.markets.filter((m) => m.paused).length;
      this.d.log(`Vigilando ${this.d.markets.length} mercados (${paused} en pausa), ${this.state.positions.length} posiciones abiertas. Valor: ${value || "—"}`);
    }
  }

  private async checkAccount(broker: Broker, markets: Market[], now: number): Promise<void> {
    if (broker.reconcile) for (const t of await broker.reconcile(this.state.positions)) await this.recordClose(t);
    if (!markets.every((m) => this.marks.has(m.id))) {
      // Without every price the account value would be wrong; skip new entries this round.
      this.equity.delete(broker.name);
      return;
    }
    let equity = await broker.equity(this.state.positions, this.marks);
    const risk = (this.state.risk[broker.name] ??= newRiskState(equity, now));
    const top = this.d.config.paper.topUp;
    const book = this.state.papers.crypto;
    if (top && broker.name === paperName("crypto") && book.topUp !== top.id) {
      // The owner adds (or takes out) simulated money: the account is worth `to` from here on.
      const added = top.to - equity;
      book.balance += added;
      book.startingBalance = top.to;
      book.topUp = top.id;
      equity = top.to;
      Object.assign(risk, newRiskState(equity, now));
      const ccy = this.d.config.accountCurrency;
      const msg = `💵 Reto 1: la cuenta simulada pasa a ${fmt.money(top.to, ccy)} (${added >= 0 ? "se añadieron" : "se retiraron"} ${fmt.money(Math.abs(added), ccy)}). Sus resultados se cuentan desde aquí.`;
      this.d.log(msg);
      await this.d.notify(msg);
    }
    this.equity.set(broker.name, equity);
    this.recovered(broker.name);
    if (updateRisk(risk, this.d.config.risk, equity, now)) {
      const msg = `⛔ ${broker.name}: trading detenido por ${risk.halted}. Cierro sus posiciones. Reanuda con "npm run status -- --reanudar".`;
      this.d.log(msg);
      await this.d.notify(msg);
    }
    // While halted, keep flattening: a close that failed is retried on the next round.
    if (risk.halted) {
      for (const p of this.state.positions.filter((x) => x.broker === broker.name)) {
        const m = this.marketById.get(p.marketId);
        const mark = this.marks.get(p.marketId);
        if (m && mark) await this.closePosition(p, m, "parada por drawdown máximo", mark.price, now);
      }
    }
  }

  private async processMarket(m: Market, candles: Candle[], now: number): Promise<void> {
    const broker = this.broker(m);
    const mark = this.marks.get(m.id)!;
    // The hourly trade has its own rules (hourlyRound): the strategy neither sees nor manages it.
    let pos = this.state.positions.find((p) => p.marketId === m.id && p.broker === broker.name && !p.kind);

    // Stops the bot watches itself: bars since the stop was set, then the latest price.
    if (pos && !broker.managesStops) {
      const from = pos.watchFrom ?? pos.openedAt;
      const bars: Bar[] = candles.filter((c) => c.time >= from);
      bars.push({ open: mark.price, high: mark.price, low: mark.price });
      for (const bar of bars) {
        const hit = checkStops(pos, bar);
        if (hit) {
          await this.closePosition(pos, m, hit.reason, hit.price, now);
          pos = undefined;
          break;
        }
      }
    }
    if (pos?.expiresAt !== undefined && now >= pos.expiresAt) {
      await this.closePosition(pos, m, "tiempo máximo", mark.price, now);
      pos = undefined;
    }

    const closed = closedCandles(candles, m.timeframe, now);
    const last = closed.at(-1);
    if (!last || last.time <= (this.state.lastBar[m.id] ?? -Infinity)) return;
    this.state.lastBar[m.id] = last.time;
    if (closed.length < minCandles(m)) {
      this.d.log(`${m.id}: solo ${closed.length} velas cerradas; hacen falta ${minCandles(m)} para operar`);
      return;
    }

    const sig = signalAt(m, closed, needsReference(m) ? { reference: this.references.get(m.timeframe) } : undefined);
    // Quiet bars of fast markets are not worth a log line each.
    if (pos || sig.entry || sig.exitLong || sig.exitShort || TIMEFRAME_MS[m.timeframe] >= 15 * 60_000) this.d.log(this.describe(m, sig, mark, pos));

    if (pos) {
      if ((pos.side === "long" && sig.exitLong) || (pos.side === "short" && sig.exitShort)) {
        await this.closePosition(pos, m, "cruce contrario de medias", mark.price, now);
        pos = undefined;
      } else if (m.strategy.trailingStopAtr > 0 && last.time >= pos.openedAt) {
        const stop = trailStop(pos, last, sig.atr, m.strategy.trailingStopAtr);
        if (stop !== null) {
          await broker.updateStop(pos, stop);
          pos.watchFrom = last.time + TIMEFRAME_MS[m.timeframe];
          this.d.log(`${m.id}: stop dinámico movido a ${fmt.price(pos.stop)}`);
        }
      }
    }
    if (!pos && sig.entry) await this.tryOpen(m, broker, sig.entry, mark, now, closed);
  }

  private async tryOpen(m: Market, broker: Broker, entry: Entry, mark: PriceMark, now: number, closed: Candle[]): Promise<void> {
    const label = `${m.id}: señal ${fmt.side(entry.side)}`;
    if (m.paused) return this.d.log(`${label} ignorada: mercado en pausa (${m.paused})`);
    if (this.state.manualPause) return this.d.log(`${label} ignorada: pausa manual (/reanudar para seguir)`);
    const equity = this.equity.get(broker.name);
    if (equity === undefined) return this.d.log(`${label} ignorada: no se pudo valorar la cuenta ${broker.name}`);
    const risk = (this.state.risk[broker.name] ??= newRiskState(equity, now));
    const open = this.state.positions.filter((p) => p.broker === broker.name && !p.kind).length;
    const check = canOpen(risk, this.d.config.risk, equity, open);
    if (!check.ok) return this.d.log(`${label} ignorada: ${check.reason}`);
    const guard = blocked(this.state.protections, m.id, now);
    if (guard) return this.d.log(`${label} ignorada: ${guard}`);

    const useContexts = this.d.config.adaptive.useContexts;
    const futures = useContexts && m.type === "crypto" ? await this.d.futures?.(m, now - 3_600_000).catch(() => undefined) : undefined;
    const { scale, arm } = scaleFor(this.d.adaptive?.() ?? null, m, contexts(closed, futures, TIMEFRAME_MS[m.timeframe]).at(-1) ?? "?", useContexts);
    if (!(scale > 0)) return this.d.log(`${label} ignorada: la evidencia reciente no respalda este contexto (${arm ? describeArm(arm) : "?"})`);
    const size = scale * positionSize({
      equity,
      price: mark.price,
      stopDistance: entry.stopDistance,
      rate: mark.rate,
      type: m.type,
      params: this.d.config.risk,
      barValue: averageBarValue(closed),
    });
    // Spot has no leverage: never commit more cash than the account has free.
    // ...and keep the hourly trade's money free when it is not holding a coin right now.
    const reserve = this.d.hourly && !this.state.positions.some((p) => p.kind === "horaria") ? this.d.config.horaria.orderUsd * 1.01 : 0;
    const free = m.type === "crypto" ? (equity - reserve - committedCash(this.state.positions.filter((p) => p.broker === broker.name), (p) => this.marks.get(p.marketId))) / (mark.price * mark.rate) : Infinity;
    const units = broker.normalizeUnits(m, Math.min(size, free * 0.995), mark.price);
    if (!(units > 0)) return this.d.log(`${label} ignorada: el tamaño (${size.toPrecision(3)}) queda por debajo del mínimo del mercado`);

    const pos = await broker.open({
      market: m,
      side: entry.side,
      units,
      price: mark.price,
      rate: mark.rate,
      stopDistance: entry.stopDistance,
      takeProfitDistance: entry.takeProfitDistance,
      time: now,
    });
    if (entry.maxBars) pos.expiresAt = now + entry.maxBars * TIMEFRAME_MS[m.timeframe];
    this.state.positions.push(pos);
    const ccy = this.d.config.accountCurrency;
    const riskAmount = Math.abs(pos.entryPrice - pos.stop) * pos.units * mark.rate;
    const msg =
      `🟢 ${broker.name}: abro ${fmt.side(pos.side)} en ${m.symbol} — ${pos.units} uds a ${fmt.price(pos.entryPrice)}` +
      `, stop ${fmt.price(pos.stop)}` +
      (pos.takeProfit !== null ? `, objetivo ${fmt.price(pos.takeProfit)}` : "") +
      ` (riesgo ${fmt.money(riskAmount, ccy)})`;
    this.d.log(msg);
    await this.d.notify(msg);
  }

  /**
   * Challenge 1's hourly trade, once per hour: the coin most likely to beat its costs over the next hour is
   * bought with `horaria.orderUsd`, or kept when it is the one already held; the previous one is sold. Neither
   * the learner's pauses nor the protections stop it (the owner asked for a trade every hour); /pausa does.
   */
  private async hourlyRound(h: Horaria, now: number): Promise<void> {
    const markets = this.d.markets.filter((m) => m.type === "crypto");
    if (!markets.length) return;
    const decision = await h.decide(now, markets);
    if (!decision) return;
    const ccy = this.d.config.accountCurrency;
    const pick = decision.ranking.find((r) => this.marks.has(r.market.id));
    const shown = pick ?? decision.ranking[0];
    let held = this.state.positions.find((p) => p.kind === "horaria");
    // /pausa, or the drawdown breaker if one is configured, stop it too.
    const stopped = this.state.manualPause || !!this.state.risk[paperName("crypto")]?.halted;
    let action: HourAction;
    if (held && pick && held.marketId === pick.market.id && !stopped) action = "mantiene";
    else {
      const m = held && this.marketById.get(held.marketId);
      const mark = held && this.marks.get(held.marketId);
      if (held && m && mark) await this.closePosition(held, m, stopped || !pick ? "fin de su hora" : `cambia a ${pick.market.base}`, mark.price, now);
      held = this.state.positions.find((p) => p.kind === "horaria"); // still there when its price did not load
      if (stopped) action = "pausa";
      else if (!pick || held) action = "sin precio";
      else action = (await this.openHourly(pick.market, now)) ? "compra" : "sin dinero";
    }
    const others = decision.ranking.filter((r) => r !== shown).slice(0, 3).map((r) => `${r.market.base} ${(r.p * 100).toFixed(0)}%`).join(", ");
    const what = action === "compra" ? `compra ${pick!.market.base}` : action === "mantiene" ? `se queda con ${pick!.market.base}` : `no opera (${action})`;
    this.d.log(`⏱️ Operación horaria ${fmt.time(decision.hour)} UTC: ${what}${shown ? ` (probabilidad ${(shown.p * 100).toFixed(0)}%; siguientes: ${others})` : ""}`);
    const daily = h.done(decision.hour, shown?.market.symbol ?? "", shown?.p ?? NaN, action, this.equity.get(paperName("crypto")), ccy);
    if (daily) await this.d.notify(daily);
  }

  /** Buys `horaria.orderUsd` of `m` for the hourly trade; false when the free cash cannot pay the minimum. */
  private async openHourly(m: Market, now: number): Promise<boolean> {
    const broker = this.broker(m);
    const mark = this.marks.get(m.id)!;
    const mine = this.state.positions.filter((p) => p.broker === broker.name);
    const free = (await broker.equity(mine, this.marks)) - committedCash(mine, (p) => this.marks.get(p.marketId));
    // A hair above the amount so rounding the units never drops it under the exchange's minimum.
    const usd = Math.min(this.d.config.horaria.orderUsd * 1.001, free * 0.995);
    const units = broker.normalizeUnits(m, usd / (mark.price * mark.rate), mark.price);
    if (!(units > 0)) return false;
    // No stop: it is sold (or kept) at the next hour's decision.
    const pos = await broker.open({ market: m, side: "long", units, price: mark.price, rate: mark.rate, stopDistance: mark.price, takeProfitDistance: null, time: now });
    pos.kind = "horaria";
    this.state.positions.push(pos);
    this.d.log(`⏱️ Operación horaria: compra ${pos.units} ${m.base} a ${fmt.price(pos.entryPrice)} (${fmt.money(pos.units * pos.entryPrice * mark.rate, this.d.config.accountCurrency)})`);
    return true;
  }

  private async closePosition(pos: Position, m: Market, reason: string, price: number, now: number): Promise<void> {
    const mark = this.marks.get(m.id);
    const rate = mark ? (mark.price === price ? mark.rate : await quoteRate(m, price, this.d.config.accountCurrency, this.d.fx)) : 1;
    const trade = await this.broker(m).close(pos, { market: m, reason, price, rate, time: now });
    await this.recordClose(trade);
  }

  private async recordClose(t: ClosedTrade): Promise<void> {
    this.state.positions = this.state.positions.filter((p) => p.id !== t.id);
    if (t.kind === "horaria") {
      // One a hour: logged and summed up once a day, not a Telegram message each.
      this.d.store.appendTrade(t);
      this.d.hourly?.closed(t);
      this.d.log(`⏱️ Operación horaria: vende ${t.symbol} a ${fmt.price(t.exitPrice)} (${t.reason}), resultado ${fmt.money(t.pnl, this.d.config.accountCurrency)}`);
      return;
    }
    this.state.recentTrades = [...this.state.recentTrades, t].slice(-MAX_RECENT_TRADES);
    this.d.store.appendTrade(t);
    const m = this.marketById.get(t.marketId);
    const tripped = onClose(this.state.protections, this.d.config.protections, t.marketId, t.reason, this.now(), m ? TIMEFRAME_MS[m.timeframe] : 60_000);
    const msg = `${t.pnl >= 0 ? "✅" : "🔴"} ${t.broker}: cierro ${fmt.side(t.side)} en ${t.symbol} a ${fmt.price(t.exitPrice)} (${t.reason}) — resultado ${fmt.money(t.pnl, this.d.config.accountCurrency)}`;
    this.d.log(msg);
    await this.d.notify(msg);
    if (tripped) {
      this.d.log(`🛡️ ${tripped}`);
      await this.d.notify(`🛡️ ${tripped}`);
    }
  }

  private describe(m: Market, sig: Signal, mark: PriceMark, pos: Position | undefined): string {
    const parts = [`${m.id} | cierre ${fmt.price(sig.close)}`];
    if (sig.info) parts.push(sig.info);
    if (pos) {
      const change = ((mark.price - pos.entryPrice) / pos.entryPrice) * 100 * (pos.side === "long" ? 1 : -1);
      parts.push(`posición ${fmt.side(pos.side)} ${fmt.pct(change)}`);
    }
    parts.push(m.paused ? `${sig.reason} (en pausa)` : sig.reason);
    return parts.join(" | ");
  }

  private async fail(key: string, err: unknown): Promise<void> {
    const count = (this.errors.get(key) ?? 0) + 1;
    this.errors.set(key, count);
    const msg = `Error en ${key}: ${(err as Error).message ?? err}`;
    // The first, then every 30th in a row: a phone without connection should not flush the whole log.
    if (count === 1 || count % 30 === 0) this.d.log(count === 1 ? msg : `${msg} (${count} veces seguidas)`);
    if (count === 5) await this.d.notify(`⚠️ ${msg} (5 veces seguidas)`);
  }

  private recovered(key: string): void {
    const count = this.errors.get(key);
    if (count && count > 1) this.d.log(`${key} responde de nuevo tras ${count} errores seguidos`);
    this.errors.delete(key);
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.init();
    const poll = this.d.config.pollSeconds * 1000;
    while (!signal.aborted) {
      const started = Date.now();
      try {
        await this.d.beforeTick?.();
        await this.tick();
      } catch (err) {
        this.d.log(`Error: ${(err as Error).message}`);
      }
      const wait = Math.max(1000, poll - (Date.now() - started));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
      });
    }
    this.d.store.save(this.state);
  }
}
