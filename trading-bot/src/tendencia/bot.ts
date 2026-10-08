import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as fmt from "../fmt.js";
import type { Notifier } from "../notify.js";
import { inTrend, makeModel, rebalance, trendWeights, type DayBar, type Fill, type Holding, type TrendView } from "./core.js";

// Challenge 3 as a running bot: its own simulated spot account. Once a day, after the daily candles close
// (00:00 UTC, 18:00 in Mexico City), it rebuilds each coin's trend from the closes and moves the account to
// its slots at the current price. The signals come from the candles alone, so a restart or a phone that
// slept through a day changes nothing: the next check acts on the last closed day.

export interface TendenciaConfig {
  enabled: boolean;
  startingBalance: number;
  coins: string[];
  quote: string;
  signal: "medias" | "canales";
  averages: number[];
  lookbacks: number[];
  threshold: number;
  minOrderUsd: number;
  feePct: number;
  slippagePct: number;
}

export interface DailySource {
  /** Daily candles from `since` (oldest first); the last one may still be forming. */
  days(symbol: string, since: number): Promise<DayBar[]>;
}

export interface TrendTrade extends Fill {
  /** When it traded. */
  time: number;
  /** Close of the day the decision came from. */
  day: number;
}

export interface TendenciaState {
  version: 1;
  startingBalance: number;
  cash: number;
  holdings: Record<string, Holding>;
  /** Start of the last daily candle acted on (0 = none yet). */
  lastDay: number;
  views: Record<string, TrendView>;
  /** Latest known price per symbol and when it was read. */
  prices: Record<string, number>;
  pricesAt: number;
  trades: TrendTrade[];
  /** Account value after each daily check. */
  equity: { day: number; value: number }[];
}

export interface TendenciaDeps {
  config: TendenciaConfig;
  source: DailySource;
  notify: Notifier;
  log: (msg: string) => void;
  /** Folder for the state and the trade log; absent = nothing is saved (backtests). */
  dir?: string;
  now?: () => number;
}

const DAY = 86_400_000;
const MINUTE = 60_000;
/** Closes read for each coin: the longest lookback plus room for its models to settle. */
export const HISTORY_DAYS = 1100;
const MAX_TRADES = 300;
const MAX_EQUITY = 400;
const CHECK_MS = 5 * MINUTE;
const PRICES_MS = 30 * MINUTE;

const short = (symbol: string) => symbol.replace(/USDT$/, "");
const usd = (v: number) => fmt.money(v, "USD");

export class TendenciaBot {
  state: TendenciaState;
  /** Since when the last check could not read its candles. */
  private failingSince?: number;

  constructor(private readonly d: TendenciaDeps) {
    this.state = this.load();
  }

  private get now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** What the trend count is out of, in messages. */
  private get unit(): string {
    return this.d.config.signal === "medias" ? "medias" : "plazos";
  }

  get symbols(): string[] {
    return this.d.config.coins.map((c) => `${c.toUpperCase()}${this.d.config.quote}`);
  }

  private load(): TendenciaState {
    const file = this.d.dir && join(this.d.dir, "estado.json");
    if (file && existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as TendenciaState;
    const b = this.d.config.startingBalance;
    return { version: 1, startingBalance: b, cash: b, holdings: {}, lastDay: 0, views: {}, prices: {}, pricesAt: 0, trades: [], equity: [] };
  }

  save(): void {
    if (!this.d.dir) return;
    mkdirSync(this.d.dir, { recursive: true });
    writeFileSync(join(this.d.dir, "estado.json"), JSON.stringify(this.state));
  }

  /** Cash plus the holdings at the latest prices. */
  value(prices = this.state.prices): number {
    return this.state.cash + Object.entries(this.state.holdings).reduce((a, [s, h]) => a + h.units * (prices[s] ?? 0), 0);
  }

  /**
   * One daily decision: `views` after the close of `day`, orders at `prices`. The live bot and the
   * backtest both go through here, so they follow the same rules.
   */
  step(day: number, views: Record<string, TrendView>, prices: Record<string, number>, at: number): TrendTrade[] {
    const c = this.d.config;
    const s = this.state;
    // Coins no longer in the list (the list changed) are sold at their price.
    const weights = { ...Object.fromEntries(Object.keys(s.holdings).map((sym) => [sym, 0])), ...trendWeights(views, this.symbols, c.threshold, c.signal === "medias") };
    const r = rebalance(s.cash, s.holdings, prices, weights, { minOrderUsd: c.minOrderUsd, cost: (c.feePct + c.slippagePct) / 100 });
    s.cash = r.cash;
    for (const [sym, h] of Object.entries(s.holdings)) if (!h.units) delete s.holdings[sym];
    s.lastDay = day;
    s.views = views;
    s.prices = { ...s.prices, ...prices };
    s.pricesAt = at;
    const trades = r.fills.map((f) => ({ ...f, time: at, day }));
    s.trades.push(...trades);
    if (s.trades.length > MAX_TRADES) s.trades.splice(0, s.trades.length - MAX_TRADES);
    s.equity.push({ day, value: this.value() });
    if (s.equity.length > MAX_EQUITY) s.equity.splice(0, s.equity.length - MAX_EQUITY);
    if (trades.length) {
      const text = this.describe(day, trades, views);
      this.d.log(text);
      void this.d.notify(text);
      this.record(trades);
    }
    return trades;
  }

  private describe(day: number, trades: TrendTrade[], views: Record<string, TrendView>): string {
    const lines = [`📈 Reto 3 (seguir tendencias), cierre del ${new Date(day).toISOString().slice(0, 10)}:`];
    for (const t of trades) {
      const v = views[t.symbol];
      const coin = short(t.symbol);
      if (t.reason === "entra") lines.push(`• compra ${coin}: ${usd(t.notional)} a ${fmt.price(t.price)} (tendencia en ${v?.on} de ${v?.models} ${this.unit})`);
      else if (t.reason === "sale") lines.push(`• vende ${coin}: ${usd(t.notional)} a ${fmt.price(t.price)}, ${(t.pnl ?? 0) >= 0 ? "gana" : "pierde"} ${usd(Math.abs(t.pnl ?? 0))} (${fmt.pct(((t.pnl ?? 0) / (t.notional - (t.pnl ?? 0))) * 100)}): salió de la tendencia`);
      else lines.push(`• ${t.side === "buy" ? "sube" : "baja"} ${coin}${v ? ` (tendencia en ${v.on} de ${v.models} ${this.unit})` : ""}: ${t.side === "buy" ? "compra" : "vende"} ${usd(t.notional)} a ${fmt.price(t.price)}`);
    }
    const s = this.state;
    lines.push(`Reto 3: ${usd(this.value())} (${fmt.pct((this.value() / s.startingBalance - 1) * 100)} desde ${usd(s.startingBalance)})`);
    return lines.join("\n");
  }

  private record(trades: TrendTrade[]): void {
    if (!this.d.dir) return;
    mkdirSync(this.d.dir, { recursive: true });
    const file = join(this.d.dir, "operaciones.csv");
    if (!existsSync(file)) appendFileSync(file, "fecha,simbolo,lado,motivo,unidades,precio,usd,comision,resultado\n");
    for (const t of trades) appendFileSync(file, `${new Date(t.time).toISOString()},${t.symbol},${t.side},${t.reason},${t.units},${t.price},${t.notional.toFixed(4)},${t.fee.toFixed(4)},${t.pnl?.toFixed(4) ?? ""}\n`);
  }

  /** Acts once on each newly closed daily candle; between them only refreshes prices now and then. */
  async tick(): Promise<void> {
    const now = this.now;
    const today = Math.floor(now / DAY) * DAY;
    const closedDay = today - DAY;
    const due = this.state.lastDay < closedDay;
    if (!due && now - this.state.pricesAt < PRICES_MS) return;
    const views: Record<string, TrendView> = {};
    const prices: Record<string, number> = {};
    const wanted = new Set(this.symbols);
    for (const symbol of [...new Set([...this.symbols, ...Object.keys(this.state.holdings)])]) {
      let bars: DayBar[];
      try {
        bars = await this.d.source.days(symbol, due ? today - HISTORY_DAYS * DAY : closedDay);
      } catch (err) {
        if (!this.failingSince) this.d.log(`Reto 3: sin velas diarias de ${short(symbol)} (${(err as Error).message}); lo intento de nuevo en unos minutos`);
        this.failingSince ??= now;
        return;
      }
      const closed = bars.filter((b) => b.time + DAY <= now);
      const last = bars.at(-1);
      if (!last || closed.at(-1)?.time !== closedDay) {
        if (!this.failingSince) this.d.log(`Reto 3: Binance aún no da la vela diaria de ayer de ${short(symbol)}; lo intento de nuevo en unos minutos`);
        this.failingSince ??= now;
        return;
      }
      prices[symbol] = last.close;
      if (due && wanted.has(symbol)) {
        const m = makeModel(this.d.config);
        for (const b of closed) m.add(b.close);
        views[symbol] = m.view();
      }
    }
    if (this.failingSince) this.d.log(`Reto 3: velas diarias de nuevo tras ${Math.round((now - this.failingSince) / MINUTE)} min`);
    this.failingSince = undefined;
    if (due) this.step(closedDay, views, prices, now);
    else {
      this.state.prices = { ...this.state.prices, ...prices };
      this.state.pricesAt = now;
    }
    this.save();
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (err) {
        this.d.log(`Reto 3: error en la vuelta: ${(err as Error).message}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CHECK_MS);
        signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
      });
    }
    this.save();
  }

  summary(): string {
    const s = this.state;
    const c = this.d.config;
    const value = this.value();
    const lines = [`📈 Reto 3, seguir tendencias: ${usd(value)} (${fmt.pct((value / s.startingBalance - 1) * 100)} desde ${usd(s.startingBalance)})`];
    if (!s.lastDay) lines.push("Todavía no revisa su primer cierre diario.");
    for (const symbol of [...new Set([...this.symbols, ...Object.keys(s.holdings)])]) {
      const v = s.views[symbol];
      const h = s.holdings[symbol];
      const price = s.prices[symbol];
      const medias = c.signal === "medias";
      const trend = !this.symbols.includes(symbol) ? "ya no está en la lista, se vende en el próximo cierre" : v ? `${medias ? (v.on ? "en tendencia" : "sin tendencia") : inTrend(v, c.threshold) ? "en tendencia" : "sin tendencia"} (${v.on} de ${v.models} ${this.unit}${medias && v.models ? `: ${Math.round((v.on / v.models) * 100)}% de su parte` : ""})` : "sin datos aún";
      const held = h?.units && price ? `${usd(h.units * price)} (${fmt.pct(((h.units * price) / h.cost - 1) * 100)})` : "en efectivo";
      lines.push(`${short(symbol)}: ${trend}, ${held}`);
    }
    lines.push(`Efectivo: ${usd(s.cash)}. Decide una vez al día, al cierre de las velas diarias (18:00 en México).`);
    return lines.join("\n");
  }

  report(): object {
    const s = this.state;
    return {
      saldo: this.value(),
      inicial: s.startingBalance,
      efectivo: s.cash,
      ultimoCierre: s.lastDay ? new Date(s.lastDay).toISOString().slice(0, 10) : null,
      tendencias: s.views,
      posiciones: s.holdings,
      precios: s.prices,
      operaciones: s.trades.slice(-100),
      historial: s.equity.slice(-60),
    };
  }
}
