import type { Broker } from "./brokers/broker.js";
import type { Config } from "./config.js";
import { quoteRate, type CandleSource, type FxRates } from "./data/source.js";
import * as fmt from "./fmt.js";
import type { Command, Notifier } from "./notify.js";
import { contexts, describeArm, scaleFor, type AdaptiveState } from "./adaptive.js";
import { blocked, onClose } from "./protections.js";
import { averageBarValue, canOpen, newRiskState, positionSize, updateRisk } from "./risk.js";
import { checkStops, trailStop, type Bar } from "./stops.js";
import type { BotState, Store } from "./store.js";
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
  /** Latest adaptive evidence; null or absent = static rules only. */
  adaptive?: () => AdaptiveState | null;
}

export const COMMAND_HELP = "/estado — saldo, posiciones y pausas\n/pausa — no abrir operaciones nuevas\n/reanudar — quitar pausas y paradas por pérdidas\n/cerrar SIMBOLO|todo — cerrar a mercado\n/ayuda";

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
      else reply = COMMAND_HELP;
      this.d.log(`Telegram /${c.name}: ${reply.split("\n")[0]}`);
      await this.d.notify(reply);
    }
  }

  private summary(now: number): string {
    const ccy = this.d.config.accountCurrency;
    const lines = [...this.equity].map(([name, v]) => `💰 ${name}: ${fmt.money(v, ccy)}`);
    for (const p of this.state.positions) {
      const mark = this.marks.get(p.marketId);
      const change = mark ? ((mark.price - p.entryPrice) / p.entryPrice) * 100 * (p.side === "long" ? 1 : -1) : NaN;
      lines.push(`• ${p.symbol} ${fmt.side(p.side)} ${fmt.pct(change)} (stop ${fmt.price(p.stop)})`);
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
        this.errors.delete(m.id);
      } catch (err) {
        await this.fail(m.id, err);
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
    const equity = await broker.equity(this.state.positions, this.marks);
    this.equity.set(broker.name, equity);
    this.errors.delete(broker.name);
    const risk = (this.state.risk[broker.name] ??= newRiskState(equity, now));
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
    let pos = this.state.positions.find((p) => p.marketId === m.id && p.broker === broker.name);

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
    const open = this.state.positions.filter((p) => p.broker === broker.name).length;
    const check = canOpen(risk, this.d.config.risk, equity, open);
    if (!check.ok) return this.d.log(`${label} ignorada: ${check.reason}`);
    const guard = blocked(this.state.protections, m.id, now);
    if (guard) return this.d.log(`${label} ignorada: ${guard}`);

    const { scale, arm } = scaleFor(this.d.adaptive?.() ?? null, m, contexts(closed).at(-1) ?? "?");
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
    const units = broker.normalizeUnits(m, size, mark.price);
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

  private async closePosition(pos: Position, m: Market, reason: string, price: number, now: number): Promise<void> {
    const mark = this.marks.get(m.id);
    const rate = mark ? (mark.price === price ? mark.rate : await quoteRate(m, price, this.d.config.accountCurrency, this.d.fx)) : 1;
    const trade = await this.broker(m).close(pos, { market: m, reason, price, rate, time: now });
    await this.recordClose(trade);
  }

  private async recordClose(t: ClosedTrade): Promise<void> {
    this.state.positions = this.state.positions.filter((p) => p.id !== t.id);
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
    this.d.log(msg);
    if (count === 5) await this.d.notify(`⚠️ ${msg} (5 veces seguidas)`);
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
