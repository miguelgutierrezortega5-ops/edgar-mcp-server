import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MinuteSource } from "../data/futures1m.js";
import * as fmt from "../fmt.js";
import type { Notifier } from "../notify.js";
import { advance, distance, fill, isFilled, leadersAllow, orderPrice, sigma15, type Bar, type ClosedTrade, type MechasParams, type Order, type Position, type Side } from "./core.js";
import { assessSide, calibration, type Outcome, type SideView } from "./learn.js";
import { compare, dayOf, describeVariant, emptyShadow, shadowMinute, trimShadow, tune, variantKey, type ShadowState, type TuneConfig, type Variant } from "./shadow.js";
import { selectCoins, type Pick } from "./universe.js";

// Challenge 2 as a running bot: its own simulated account, minute by minute. The same steps serve the
// live bot and the backtest (`processMinute`), so both follow identical rules. While the bot is not
// running (phone asleep) it places no orders, but open positions keep their target and stop, as they
// would resting on the exchange: catching up, missed minutes are replayed for exits only. An order decided
// late into its minute is skipped too: a real one would have missed the first part of that candle. A minute
// is processed only once every candle is in (a phone without connection waits), so no exit is skipped.

export interface MechasConfig {
  enabled: boolean;
  startingBalance: number;
  coins: number;
  refreshDays: number;
  minVolumeUsd: number;
  maxVolumeUsd: number;
  minAgeDays: number;
  exclude: string[];
  leaders: string[];
  shorts: boolean;
  k: number;
  takeProfit: number;
  stop: number;
  maxMinutes: number;
  minDistancePct: number;
  throughPct: number;
  leaderMovePct: number;
  orderPct: number;
  minOrderUsd: number;
  maxPositions: number;
  leverage: number;
  makerFeePct: number;
  takerFeePct: number;
  slippagePct: number;
  halfLifeDays: number;
  priorTrades: number;
  priorMeanPct: number;
  priorWinRate: number;
  minTrades: number;
  minProbability: number;
  fullProbability: number;
  variants: Variant[];
  autoTune: boolean;
  tuneMinDays: number;
  tuneHalfLifeDays: number;
  tuneZ: number;
}

export interface MechasState {
  version: 1;
  balance: number;
  startingBalance: number;
  coins: Pick[];
  coinsAt: number;
  /** Start time of the last processed minute. */
  lastMinute: number;
  /** Orders resting in the next minute. */
  pending: Order[];
  positions: Position[];
  /** Latest real trades. */
  closed: ClosedTrade[];
  /** Real and virtual results, for learning. */
  outcomes: Outcome[];
  /** Entry/exit variants followed in the shadow (absent in states saved before they existed). */
  shadow?: ShadowState;
  /** When the first real trade was entered. */
  firstTradeAt?: number;
  /** Per UTC day, minutes with orders placed and minutes without (asleep, late, offline or restarting). */
  coverage?: Record<string, { live: number; missed: number }>;
}

const MINUTE = 60_000;
const DAY = 86_400_000;
const KEEP_BARS = 400;
const MAX_CLOSED = 300;
const MAX_OUTCOMES = 4000;
/** Orders decided later than this into their minute are not placed. */
const LATE_MS = 15_000;
/** When only some coins fail to load, wait this long before going on without them. */
const WAIT_MS = 10 * 60_000;
const COVERAGE_DAYS = 14;

export function mechasParams(c: MechasConfig): MechasParams {
  return {
    k: c.k,
    takeProfit: c.takeProfit,
    stop: c.stop,
    maxMinutes: c.maxMinutes,
    minDistance: c.minDistancePct / 100,
    through: c.throughPct / 100,
    makerFee: c.makerFeePct / 100,
    takerFee: c.takerFeePct / 100,
    slippage: c.slippagePct / 100,
    leaderMove: c.leaderMovePct / 100,
  };
}

const learnConfig = (c: MechasConfig) => ({
  halfLifeDays: c.halfLifeDays,
  priorTrades: c.priorTrades,
  priorMean: c.priorMeanPct / 100,
  priorWinRate: c.priorWinRate,
  minTrades: c.minTrades,
  minProbability: c.minProbability,
  fullProbability: c.fullProbability,
});

const short = (symbol: string) => symbol.replace(/USDT$/, "");
const sideName = (s: Side) => (s === "long" ? "compra en mecha" : "venta en pico");

export interface MechasDeps {
  config: MechasConfig;
  source: MinuteSource;
  notify: Notifier;
  log: (msg: string) => void;
  /** Folder for the state and the trade log; absent = nothing is saved (backtests). */
  dir?: string;
  now?: () => number;
  /** Called once, on the account's first real trade. */
  onFirstTrade?: () => void;
}

export class MechasBot {
  state: MechasState;
  private readonly bars = new Map<string, Bar[]>();
  /** Since when some candles fail to load (no connection). */
  private offlineSince?: number;
  private readonly p: MechasParams;
  /** Shadow variants by key; the configured one first. */
  private readonly variants: Map<string, Variant>;
  private readonly baseKey: string;

  constructor(private readonly d: MechasDeps) {
    this.p = mechasParams(d.config);
    const base: Variant = { k: d.config.k, takeProfit: d.config.takeProfit, stop: d.config.stop, maxMinutes: d.config.maxMinutes };
    this.baseKey = variantKey(base);
    this.variants = new Map([base, ...d.config.variants].map((v) => [variantKey(v), v]));
    this.state = this.load();
  }

  private get shadow(): ShadowState {
    const s = (this.state.shadow ??= emptyShadow(this.baseKey, dayOf(this.now)));
    for (const side of ["long", "short"] as Side[]) if (!this.variants.has(s.active[side])) s.active[side] = this.baseKey;
    return s;
  }

  /** Strategy parameters of a side: its active variant. */
  private paramsFor(side: Side): MechasParams {
    return { ...this.p, ...this.variants.get(this.shadow.active[side]) };
  }

  private get now(): number {
    return (this.d.now ?? Date.now)();
  }

  private load(): MechasState {
    const file = this.d.dir && join(this.d.dir, "estado.json");
    if (file && existsSync(file)) {
      const s = JSON.parse(readFileSync(file, "utf8")) as MechasState;
      // Saved before firstTradeAt existed: an earlier real trade already was the first.
      s.firstTradeAt ??= s.closed[0]?.openedAt ?? s.positions.find((p) => !p.virtual)?.openedAt;
      return s;
    }
    const b = this.d.config.startingBalance;
    return { version: 1, balance: b, startingBalance: b, coins: [], coinsAt: 0, lastMinute: 0, pending: [], positions: [], closed: [], outcomes: [] };
  }

  save(): void {
    if (!this.d.dir) return;
    mkdirSync(this.d.dir, { recursive: true });
    writeFileSync(join(this.d.dir, "estado.json"), JSON.stringify(this.state));
  }

  /** Coins to watch: the selection plus any coin that still has an open position. */
  get symbols(): string[] {
    return [...new Set([...this.state.coins.map((c) => c.symbol), ...this.state.positions.map((p) => p.symbol), ...this.d.config.leaders])];
  }

  /** Feeds bars directly (backtests, tests). */
  addBars(symbol: string, bars: Bar[]): void {
    let have = this.bars.get(symbol);
    if (!have) this.bars.set(symbol, (have = []));
    for (const b of bars) if (b.time > (have.at(-1)?.time ?? -Infinity)) have.push(b);
    if (have.length > KEEP_BARS * 2) have.splice(0, have.length - KEEP_BARS);
  }

  setCoins(coins: Pick[], at: number): void {
    this.state.coins = coins;
    this.state.coinsAt = at;
  }

  private barAt(symbol: string, t: number): Bar | undefined {
    const bars = this.bars.get(symbol);
    if (!bars) return undefined;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].time === t) return bars[i];
      if (bars[i].time < t) return undefined;
    }
    return undefined;
  }

  private closesUpTo(symbol: string, t: number, n: number): number[] {
    const bars = this.bars.get(symbol) ?? [];
    let end = bars.length;
    while (end > 0 && bars[end - 1].time > t) end--;
    return bars.slice(Math.max(0, end - n), end).map((b) => b.close);
  }

  private leaderMoves(t: number): number[] {
    return this.d.config.leaders.map((s) => {
      const now = this.barAt(s, t)?.close;
      const before = this.barAt(s, t - 5 * MINUTE)?.close;
      return now && before ? now / before - 1 : NaN;
    });
  }

  private cached?: { key: string; views: Record<Side, SideView> };

  views(now = this.now): Record<Side, SideView> {
    // Recomputed when a result arrives, or every 10 minutes for the decay.
    const key = `${this.state.outcomes.length}:${this.state.outcomes.at(-1)?.time}:${Math.floor(now / (10 * MINUTE))}`;
    if (this.cached?.key === key) return this.cached.views;
    const c = learnConfig(this.d.config);
    const views = { long: assessSide(this.state.outcomes, "long", now, c), short: assessSide(this.state.outcomes, "short", now, c) };
    this.cached = { key, views };
    return views;
  }

  private settle(pos: Position, trade: ClosedTrade): void {
    this.state.positions = this.state.positions.filter((p) => p !== pos);
    this.state.outcomes.push({ side: trade.side, time: trade.closedAt, ret: trade.ret, virtual: trade.virtual });
    if (this.state.outcomes.length > MAX_OUTCOMES) this.state.outcomes.splice(0, this.state.outcomes.length - MAX_OUTCOMES);
    if (trade.virtual) return;
    this.state.balance += trade.pnl;
    this.state.closed.push(trade);
    if (this.state.closed.length > MAX_CLOSED) this.state.closed.splice(0, this.state.closed.length - MAX_CLOSED);
    const text = `🪝 ${short(trade.symbol)} ${sideName(trade.side)}: ${fmt.price(trade.entry)} → ${fmt.price(trade.exit)} (${trade.reason}), ${fmt.pct(trade.ret * 100)} = ${fmt.money(trade.pnl, "USD")}. Reto 2: ${fmt.money(this.state.balance, "USD")}`;
    this.d.log(text);
    void this.d.notify(text);
    if (this.d.dir) {
      const file = join(this.d.dir, "operaciones.csv");
      if (!existsSync(file)) appendFileSync(file, "abierta,cerrada,moneda,lado,entrada,salida,motivo,nominal,pnl,rendimiento,prob_prevista\n");
      appendFileSync(file, [fmt.time(trade.openedAt), fmt.time(trade.closedAt), trade.symbol, trade.side, trade.entry, trade.exit, trade.reason, trade.notional.toFixed(2), trade.pnl.toFixed(4), trade.ret.toFixed(5), trade.predicted.pWin.toFixed(3)].join(",") + "\n");
    }
  }

  /**
   * One minute: exits of open positions, fills of the orders resting during it and, when `live`, the
   * orders for the next minute. Bars must already be loaded up to `t`.
   */
  processMinute(t: number, live: boolean): void {
    const p = this.p;
    for (const pos of [...this.state.positions]) {
      const bar = this.barAt(pos.symbol, t);
      if (!bar || bar.time <= pos.openedAt) continue;
      const done = advance(pos, bar, this.paramsFor(pos.side));
      if (done) this.settle(pos, done);
    }
    const resting = this.state.pending.filter((o) => o.forTime === t);
    this.state.pending = this.state.pending.filter((o) => o.forTime > t);
    for (const symbol of new Set(resting.map((o) => o.symbol))) {
      const bar = this.barAt(symbol, t);
      if (!bar) continue;
      const hits = resting.filter((o) => o.symbol === symbol && isFilled(o, bar, p));
      // Both sides in one minute: the candle cannot say which came first, so neither counts.
      if (hits.length !== 1 || this.state.positions.some((x) => x.symbol === symbol)) continue;
      const order = { ...hits[0] };
      if (!order.virtual && this.state.positions.filter((x) => !x.virtual).length >= this.d.config.maxPositions) order.virtual = true;
      const { position, closed } = fill(order, bar, this.paramsFor(order.side));
      this.state.positions.push(position);
      if (!position.virtual && !closed) this.announceEntry(position);
      if (closed) this.settle(position, closed);
      if (!position.virtual && !this.state.firstTradeAt) {
        this.state.firstTradeAt = t;
        this.d.onFirstTrade?.();
      }
    }
    shadowMinute(this.shadow, [...this.variants.values()], this.state.coins, t, this.market, p, this.d.config.shorts);
    if (dayOf(t) > this.shadow.checkedDay) this.retune(dayOf(t));
    if (live) this.placeOrders(t);
    this.state.lastMinute = t;
  }

  private announceEntry(pos: Position): void {
    const text = `🪝 ${short(pos.symbol)} ${sideName(pos.side)}: entra a ${fmt.price(pos.entry)} con ${fmt.money(pos.notional, "USD")}, objetivo ${fmt.price(pos.takeProfit)}, stop ${fmt.price(pos.stopLoss)}, máximo ${Math.round((pos.expiresAt - pos.openedAt) / MINUTE)} min. Estimaba ganar el ${(pos.predicted.pWin * 100).toFixed(0)}% de las veces`;
    this.d.log(text);
    void this.d.notify(text);
  }

  private readonly market = {
    bar: (symbol: string, t: number) => this.barAt(symbol, t),
    sigma: (symbol: string, t: number) => sigma15(this.closesUpTo(symbol, t, 241)),
    leaderMoves: (t: number) => this.leaderMoves(t),
  };

  /** Once a day: move a side to a shadow variant that clearly beat its own. */
  private retune(today: number): void {
    const s = this.shadow;
    s.checkedDay = today;
    trimShadow(s, today);
    const c: TuneConfig = this.d.config;
    for (const side of ["long", "short"] as Side[]) {
      if (side === "short" && !this.d.config.shorts) continue;
      const best = tune(s, side, [...this.variants.keys()], today, c);
      if (!best) continue;
      const days = today - s.since;
      s.switches.push({ time: today * DAY, side, from: s.active[side], to: best.key, z: best.z, days });
      s.active[side] = best.key;
      const text = `🔧 Reto 2 ajusta sus ${side === "long" ? "compras en mecha" : "ventas en pico"}: ${describeVariant(this.variants.get(best.key)!)}. En ${days} días en la sombra ganó ${fmt.pct(best.edge * 100)} por día más que la anterior (z ${best.z.toFixed(1)}, exige ${c.tuneZ}).`;
      this.d.log(text);
      void this.d.notify(text);
    }
  }

  /** The shadow variants of each side, best first, against the active one. */
  shadowView(now = this.now): { dias: number; lados: Record<string, { activa: string; variantes: { variante: string; mediaDiaria: number; ventaja: number; z: number }[] }>; cambios: ShadowState["switches"] } {
    const s = this.shadow;
    const today = dayOf(now);
    const lados: Record<string, { activa: string; variantes: { variante: string; mediaDiaria: number; ventaja: number; z: number }[] }> = {};
    let dias = 0;
    for (const side of ["long", "short"] as Side[]) {
      const c = compare(s, side, [...this.variants.keys()], today, this.d.config.tuneHalfLifeDays);
      dias = c.days;
      lados[side] = { activa: s.active[side], variantes: c.rows.map((r) => ({ variante: r.key, mediaDiaria: r.mean, ventaja: r.edge, z: r.z })) };
    }
    return { dias, lados, cambios: s.switches };
  }

  private placeOrders(t: number): void {
    const c = this.d.config;
    const views = this.views(t);
    const moves = this.leaderMoves(t);
    const equity = this.state.balance;
    let margin = this.state.positions.filter((x) => !x.virtual).reduce((a, x) => a + x.notional, 0) / c.leverage;
    const sides: Side[] = c.shorts ? ["long", "short"] : ["long"];
    for (const coin of this.state.coins) {
      if (this.state.positions.some((x) => x.symbol === coin.symbol)) continue;
      const ref = this.barAt(coin.symbol, t)?.close;
      const sigma = sigma15(this.closesUpTo(coin.symbol, t, 241));
      if (!ref || !Number.isFinite(sigma)) continue;
      for (const side of sides) {
        if (!leadersAllow(side, moves, this.p)) continue;
        const dist = distance(sigma, this.paramsFor(side));
        const v = views[side];
        const base = Math.max(c.minOrderUsd, (equity * c.orderPct) / 100);
        const notional = Math.max(c.minOrderUsd, base * v.scale);
        // Resting orders reserve margin on the exchange; without room the order is only followed.
        const virtual = v.scale === 0 || margin + notional / c.leverage > equity;
        if (!virtual) margin += notional / c.leverage;
        this.state.pending.push({ symbol: coin.symbol, side, price: orderPrice(side, ref, dist), distance: dist, forTime: t + MINUTE, notional: virtual ? base : notional, virtual, tick: coin.tick, predicted: { pWin: v.pWin, mean: v.mean } });
      }
    }
  }

  async refreshCoins(): Promise<void> {
    const c = this.d.config;
    const picks = await selectCoins(this.d.source, c, this.d.log);
    if (!picks.length) throw new Error("ninguna moneda cumple los filtros");
    this.setCoins(picks, this.now);
    const text = `🪝 Reto 2 vigila las ${picks.length} altcoins más volátiles de 30 días: ${picks.map((x) => `${short(x.symbol)} ${(x.range * 100).toFixed(0)}%`).join(", ")}`;
    this.d.log(text);
    await this.d.notify(text);
  }

  /** Loads what is missing and processes every closed minute since the last one. */
  async tick(): Promise<void> {
    const now = this.now;
    const c = this.d.config;
    if (!this.state.coins.length || now - this.state.coinsAt >= c.refreshDays * DAY) {
      try {
        await this.refreshCoins();
      } catch (err) {
        this.d.log(`Reto 2: no se pudo elegir monedas (${(err as Error).message})`);
        if (!this.state.coins.length) return;
      }
    }
    const latest = Math.floor(now / MINUTE) * MINUTE - MINUTE;
    const prev = this.state.lastMinute;
    if (latest <= prev) return;
    // A long gap: positions have expired; replay at most a day.
    const from = Math.max(prev + MINUTE, latest - DAY);
    // All at once: one slow answer on a phone's connection should not hold up the minute for the rest.
    const symbols = this.symbols;
    const failed: string[] = [];
    let reason = "";
    await Promise.all(
      symbols.map(async (symbol) => {
        const have = this.bars.get(symbol)?.at(-1)?.time;
        const since = have && have >= latest - DAY ? have + MINUTE : Math.min(from, latest - 300 * MINUTE);
        try {
          this.addBars(symbol, await this.d.source.minutes(symbol, since, now));
        } catch (err) {
          failed.push(short(symbol));
          reason = (err as Error).message;
        }
      }),
    );
    if (failed.length) {
      if (!this.offlineSince) this.d.log(`Reto 2: sin velas de ${failed.length === symbols.length ? "ninguna moneda" : failed.join(", ")} (${reason}); espero a tenerlas`);
      this.offlineSince ??= now;
      // A minute without its candle would skip exits and resting orders: wait for it (catching up later
      // replays it). Only coins that keep failing while the rest load are left out, after a while.
      if (prev && (failed.length === symbols.length || now - this.offlineSince < WAIT_MS)) return;
    } else if (this.offlineSince) {
      this.d.log(`Reto 2: velas de nuevo tras ${Math.round((now - this.offlineSince) / MINUTE)} min sin ellas`);
      this.offlineSince = undefined;
    }
    const onTime = this.now - (latest + MINUTE) <= LATE_MS;
    for (let t = from; t <= latest; t += MINUTE) {
      const live = t === latest && onTime;
      this.processMinute(t, live);
      if (prev) this.count(t, live);
    }
    this.save();
  }

  private count(t: number, live: boolean): void {
    const c = (this.state.coverage ??= {});
    const day = new Date(t).toISOString().slice(0, 10);
    const d = (c[day] ??= { live: 0, missed: 0 });
    if (live) d.live++;
    else d.missed++;
    for (const k of Object.keys(c).sort().slice(0, -COVERAGE_DAYS)) delete c[k];
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (err) {
        this.d.log(`Reto 2: error en la vuelta: ${(err as Error).message}`);
      }
      // Just after each minute closes, when Binance has the candle.
      const wait = MINUTE - (this.now % MINUTE) + 3_000;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
      });
    }
    this.save();
  }

  summary(now = this.now): string {
    const s = this.state;
    const ccy = "USD";
    const change = ((s.balance / s.startingBalance - 1) * 100).toFixed(2);
    const lines = [`🪝 Reto 2, cazador de mechas: ${fmt.money(s.balance, ccy)} (${Number(change) >= 0 ? "+" : ""}${change}% desde ${fmt.money(s.startingBalance, ccy)})`];
    const real = s.positions.filter((p) => !p.virtual);
    for (const p of real) lines.push(`• ${short(p.symbol)} ${sideName(p.side)} a ${fmt.price(p.entry)}, objetivo ${fmt.price(p.takeProfit)}, stop ${fmt.price(p.stopLoss)}`);
    if (!real.length) lines.push("Sin posiciones abiertas.");
    const day = new Date(now).toISOString().slice(0, 10);
    const today = s.closed.filter((t) => new Date(t.closedAt).toISOString().startsWith(day));
    lines.push(`Hoy: ${today.length} operaciones, ${today.filter((t) => t.ret > 0).length} ganadoras, ${fmt.money(today.reduce((a, t) => a + t.pnl, 0), ccy)}`);
    const cov = s.coverage?.[day];
    if (cov?.missed) lines.push(`Minutos sin órdenes hoy: ${cov.missed} de ${cov.live + cov.missed} (celular dormido, sin red, atrasado o reiniciando)`);
    for (const v of Object.values(this.views(now))) {
      if (v.side === "short" && !this.d.config.shorts) continue;
      lines.push(`${v.side === "long" ? "Compras en mecha" : "Ventas en pico"}: gana el ${(v.pWin * 100).toFixed(0)}% estimado, media ${fmt.pct(v.mean * 100)} → ${v.scale > 0 ? `tamaño ×${v.scale.toFixed(2)}` : "solo observa"} (${v.why})`);
    }
    const cal = calibration(s.closed.slice(-100));
    if (cal.n) lines.push(`Predicción vs. realidad (últimas ${cal.n}): esperaba ganar el ${(cal.predicted * 100).toFixed(0)}%, ganó el ${(cal.realized * 100).toFixed(0)}%`);
    const sh = this.shadowView(now);
    const c = this.d.config;
    if (!sh.dias) lines.push(`En la sombra: midiendo ${this.variants.size} variantes de entrada y salida desde hoy (cambia sola con ventaja z ≥ ${c.tuneZ} tras ${c.tuneMinDays} días)`);
    else
      for (const [side, v] of Object.entries(sh.lados)) {
        if (side === "short" && !c.shorts) continue;
        const best = v.variantes.find((x) => x.variante !== v.activa);
        const name = side === "long" ? "compras" : "ventas";
        lines.push(`En la sombra (${sh.dias} de ${c.tuneMinDays} días): ${name} con ${v.activa}${best ? `; mejor alternativa ${best.variante}, ${fmt.pct(best.ventaja * 100)}/día, z ${best.z.toFixed(1)} (cambia con ${c.tuneZ})` : ""}`);
      }
    lines.push(`Monedas: ${s.coins.map((x) => short(x.symbol)).join(", ") || "(eligiendo)"}`);
    return lines.join("\n");
  }

  report(now = this.now): object {
    const s = this.state;
    return {
      saldo: s.balance,
      inicial: s.startingBalance,
      monedas: s.coins,
      elegidasEn: s.coinsAt ? new Date(s.coinsAt).toISOString() : null,
      posiciones: s.positions,
      operaciones: s.closed.slice(-100),
      lados: this.views(now),
      calibracion: calibration(s.closed.slice(-100)),
      observadas: s.outcomes.filter((o) => o.virtual).length,
      sombra: this.shadowView(now),
      minutosConOrdenes: s.coverage ?? {},
    };
  }
}
