#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { unrealized } from "./brokers/broker.js";
import { backtest, type BacktestResult } from "./backtest.js";
import { loadConfig, type Config } from "./config.js";
import { fiatOf, quoteRate } from "./data/source.js";
import { Bot, historyStart } from "./engine.js";
import * as fmt from "./fmt.js";
import { telegramNotifier } from "./notify.js";
import { buildBrokers, buildSources } from "./setup.js";
import { Store } from "./store.js";
import { computeIndicators, evaluate, minCandles } from "./strategy.js";
import { closedCandles, TIMEFRAME_MS } from "./timeframes.js";
import type { Market, PriceMark } from "./types.js";

const HELP = `Bot de trading de criptomonedas y divisas

Uso: node dist/index.js <comando> [opciones]   (o npm run <comando> -- [opciones])

Comandos:
  scan                     Muestra el estado de cada mercado: tendencia, medias, RSI, volatilidad y señal
  backtest                 Prueba la estrategia con datos históricos
      --dias N             Días de historia (por defecto 365)
      --mercado SIMBOLO    Solo ese mercado, p. ej. BTC/USDT
      --operaciones        Lista cada operación
  run (o bot)              Arranca el bot: vigila los mercados y opera según la configuración
      --once               Hace una sola pasada y termina (útil con cron)
  status                   Saldo, posiciones abiertas, últimas operaciones y límites de riesgo
      --reanudar           Reactiva el trading tras una parada por drawdown

Opciones generales:
  --config RUTA            Archivo de configuración (por defecto config.json, o config.example.json si no existe)

Por defecto todo funciona en modo simulado (paper trading), sin claves ni dinero real.`;

const log = (msg: string) => console.log(`[${new Date().toISOString().slice(0, 19).replace("T", " ")}] ${msg}`);
const DAY = 86_400_000;

async function scan(config: Config, markets: Market[]): Promise<void> {
  const { sources: src } = buildSources(config, markets);
  const now = Date.now();
  const rows: string[][] = [];
  for (const m of markets) {
    try {
      const candles = await src[m.type]!.history(m, historyStart(m, config.historyBars, now));
      const closed = closedCandles(candles, m.timeframe, now);
      const last = candles.at(-1)!;
      const dayAgo = [...candles].reverse().find((c) => c.time <= last.time - DAY);
      if (closed.length < minCandles(m.strategy)) {
        rows.push([m.id, fmt.price(last.close), "", "", "", "", "", `solo ${closed.length} velas cerradas`]);
        continue;
      }
      const sig = evaluate(computeIndicators(closed, m.strategy), closed.length - 1, m.strategy, m.allowShort);
      const s = sig.snapshot;
      rows.push([
        m.id,
        fmt.price(last.close),
        dayAgo ? fmt.pct((last.close / dayAgo.close - 1) * 100) : "—",
        s.close > s.trend ? "alcista" : "bajista",
        `EMA${m.strategy.fastEma} ${s.fast > s.slow ? ">" : "<"} EMA${m.strategy.slowEma}`,
        s.rsi.toFixed(1),
        `${((s.atr / s.close) * 100).toFixed(2)}%`,
        sig.entry ? `ENTRADA ${fmt.side(sig.entry.side).toUpperCase()}` : sig.reason,
      ]);
    } catch (err) {
      rows.push([m.id, "", "", "", "", "", "", `error: ${(err as Error).message}`]);
    }
  }
  console.log(`Mercados a ${fmt.time(now)} UTC (indicadores sobre la última vela cerrada)\n`);
  console.log(fmt.table(["Mercado", "Precio", "24h", "Tendencia", "Medias", "RSI", "ATR", "Señal"], rows));
}

async function runBacktest(config: Config, markets: Market[], opts: { days: number; market?: string; listTrades: boolean }): Promise<void> {
  const selected = opts.market ? markets.filter((m) => m.symbol === opts.market!.toUpperCase() || m.id.toUpperCase() === opts.market!.toUpperCase()) : markets;
  if (!selected.length) throw new Error(`No hay ningún mercado ${opts.market} en la configuración`);
  const { sources: src, fx } = buildSources(config, selected);
  const now = Date.now();
  const tradeFrom = now - opts.days * DAY;
  const results: BacktestResult[] = [];
  const ccy = config.accountCurrency;
  for (const m of selected) {
    try {
      const warmup = minCandles(m.strategy) * 3;
      const since = historyStart(m, warmup, tradeFrom);
      const candles = closedCandles(await src[m.type]!.history(m, since), m.timeframe, now);
      if (candles.length && candles[0].time > tradeFrom) {
        log(`${m.id}: la fuente solo da historia desde ${fmt.time(candles[0].time)}; el backtest es más corto de lo pedido`);
      }
      let rateAt: (price: number) => number;
      if (fiatOf(m.quote) === ccy) rateAt = () => 1;
      else if (fiatOf(m.base) === ccy) rateAt = (p) => 1 / p;
      else {
        const r = await quoteRate(m, candles.at(-1)?.close ?? 1, ccy, fx);
        rateAt = () => r;
      }
      results.push(backtest({ market: m, candles, risk: config.risk, costs: config.paper, startingBalance: config.paper.startingBalance, rateAt, tradeFrom }));
    } catch (err) {
      log(`${m.id}: ${(err as Error).message}`);
    }
  }
  if (!results.length) return;

  const pf = (v: number) => (Number.isNaN(v) ? "—" : v === Infinity ? "∞" : v.toFixed(2));
  console.log(`\nBacktest — capital inicial ${fmt.money(config.paper.startingBalance, ccy)} por mercado, riesgo ${config.risk.riskPerTradePct}% por operación\n`);
  console.log(
    fmt.table(
      ["Mercado", "Desde", "Hasta", "Ops", "Aciertos", "F. beneficio", "Resultado", "Rentab.", "Comprar y mantener", "Máx. caída", "Comisiones", "Exposición"],
      results.map((r) => [
        r.market.id,
        fmt.time(r.from).slice(0, 10),
        fmt.time(r.to).slice(0, 10),
        String(r.trades.length),
        Number.isNaN(r.winRatePct) ? "—" : `${r.winRatePct.toFixed(0)}%`,
        pf(r.profitFactor),
        fmt.money(r.endEquity - r.startEquity, ccy),
        fmt.pct(r.returnPct),
        fmt.pct(r.buyHoldPct),
        `-${r.maxDrawdownPct.toFixed(1)}%`,
        fmt.money(r.fees, ccy),
        `${r.exposurePct.toFixed(0)}%`,
      ]),
    ),
  );
  const total = results.reduce((s, r) => s + r.endEquity - r.startEquity, 0);
  console.log(`\nResultado conjunto: ${fmt.money(total, ccy)} sobre ${fmt.money(config.paper.startingBalance * results.length, ccy)} (${fmt.pct((total / (config.paper.startingBalance * results.length)) * 100)})`);
  for (const r of results.filter((x) => x.halted)) console.log(`${r.market.id}: se detuvo por ${r.halted}`);

  if (opts.listTrades) {
    for (const r of results) {
      if (!r.trades.length) continue;
      console.log(`\n${r.market.id}`);
      console.log(
        fmt.table(
          ["Entrada", "Salida", "Lado", "Precio entrada", "Precio salida", "Resultado", "Motivo"],
          r.trades.map((t) => [fmt.time(t.openedAt), fmt.time(t.closedAt), fmt.side(t.side), fmt.price(t.entryPrice), fmt.price(t.exitPrice), fmt.money(t.pnl, ccy), t.reason]),
        ),
      );
    }
  }
  console.log(
    "\nOjo: un backtest no garantiza resultados futuros. Incluye comisiones, deslizamiento y spread simulados, pero no huecos de liquidez, " +
      "caídas del exchange ni el coste de financiación de las posiciones apalancadas de divisas.",
  );
}

async function status(config: Config, markets: Market[], resume: boolean): Promise<void> {
  const store = new Store(config.dataDir);
  if (!existsSync(store.statePath)) {
    console.log(`Todavía no hay estado guardado en ${store.statePath}: el bot no ha arrancado aún.`);
    return;
  }
  const state = store.load(config.paper.startingBalance);
  const ccy = config.accountCurrency;
  if (resume) {
    for (const [name, r] of Object.entries(state.risk)) {
      if (r.halted) console.log(`${name}: trading reactivado (estaba detenido por ${r.halted})`);
      r.halted = null;
      r.peakEquity = 0; // the next tick restarts the drawdown count from the current equity
    }
    store.save(state);
  }

  const marks = new Map<string, PriceMark>();
  const byId = new Map(markets.map((m) => [m.id, m]));
  const open = state.positions.filter((p) => byId.has(p.marketId));
  if (open.length) {
    const { sources: src, fx } = buildSources(config, open.map((p) => byId.get(p.marketId)!));
    for (const p of open) {
      const m = byId.get(p.marketId)!;
      try {
        const candles = await src[m.type]!.history(m, Date.now() - 3 * TIMEFRAME_MS[m.timeframe]);
        const price = candles.at(-1)!.close;
        marks.set(m.id, { price, rate: await quoteRate(m, price, ccy, fx) });
      } catch {
        // shown without current price
      }
    }
  }

  const paperOpen = state.positions.filter((p) => p.broker === "paper");
  const paperEquity = paperOpen.reduce((s, p) => s + unrealized(p, marks.get(p.marketId)), state.paper.balance);
  console.log(`Cuenta simulada (paper): saldo ${fmt.money(state.paper.balance, ccy)}, valor con posiciones ${fmt.money(paperEquity, ccy)}`);
  console.log(`  Capital inicial ${fmt.money(state.paper.startingBalance, ccy)} → ${fmt.pct((paperEquity / state.paper.startingBalance - 1) * 100)}`);

  console.log(`\nPosiciones abiertas (${state.positions.length})`);
  if (state.positions.length) {
    console.log(
      fmt.table(
        ["Mercado", "Broker", "Lado", "Unidades", "Entrada", "Actual", "Stop", "Objetivo", "Resultado", "Abierta"],
        state.positions.map((p) => {
          const mark = marks.get(p.marketId);
          return [
            p.marketId,
            p.broker,
            fmt.side(p.side),
            String(p.units),
            fmt.price(p.entryPrice),
            mark ? fmt.price(mark.price) : "—",
            fmt.price(p.stop),
            p.takeProfit === null ? "—" : fmt.price(p.takeProfit),
            mark ? fmt.money(unrealized(p, mark) - p.entryFee, ccy) : "—",
            fmt.time(p.openedAt),
          ];
        }),
      ),
    );
  }

  const recent = state.recentTrades.slice(-10).reverse();
  const realized = state.recentTrades.reduce((s, t) => s + t.pnl, 0);
  const wins = state.recentTrades.filter((t) => t.pnl > 0).length;
  console.log(`\nÚltimas operaciones cerradas (${state.recentTrades.length} guardadas, ${wins} ganadoras, resultado ${fmt.money(realized, ccy)}; historial completo en ${store.tradesPath})`);
  if (recent.length) {
    console.log(
      fmt.table(
        ["Cerrada", "Mercado", "Broker", "Lado", "Entrada", "Salida", "Resultado", "Motivo"],
        recent.map((t) => [fmt.time(t.closedAt), t.symbol, t.broker, fmt.side(t.side), fmt.price(t.entryPrice), fmt.price(t.exitPrice), fmt.money(t.pnl, ccy), t.reason]),
      ),
    );
  }

  console.log("\nLímites de riesgo");
  for (const [name, r] of Object.entries(state.risk)) {
    console.log(`  ${name}: máximo ${fmt.money(r.peakEquity, ccy)}, inicio del día ${fmt.money(r.dayStartEquity, ccy)} (${r.day})${r.halted ? ` — DETENIDO: ${r.halted}` : ""}`);
  }
}

async function run(config: Config, markets: Market[], path: string, once: boolean): Promise<void> {
  const store = new Store(config.dataDir);
  const state = store.load(config.paper.startingBalance);
  const { sources: src, fx } = buildSources(config, markets);
  const brokers = buildBrokers(config, markets, state);
  const notify = telegramNotifier(config.telegram.enabled, log);
  const bot = new Bot({ config, markets, sources: src, brokers, fx, store, state, notify, log });

  log(`Configuración: ${path}. Revisión cada ${config.pollSeconds} s.`);
  for (const m of markets) {
    const b = brokers[m.type]!;
    const mode = b.realMoney ? "DINERO REAL" : b.name === "paper" ? "simulado" : "cuenta de pruebas";
    log(`  ${m.id.padEnd(14)} → ${b.name} (${mode})${m.allowShort ? ", largos y cortos" : ", solo largos"}`);
  }
  if (once) {
    await bot.init();
    await bot.tick();
    return;
  }
  const controller = new AbortController();
  const stop = () => {
    log("Deteniendo el bot (las posiciones abiertas se mantienen)…");
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await notify(`🤖 Bot iniciado: ${markets.map((m) => m.id).join(", ")}`);
  await bot.run(controller.signal);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      once: { type: "boolean", default: false },
      dias: { type: "string" },
      mercado: { type: "string" },
      operaciones: { type: "boolean", default: false },
      reanudar: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0];
  if (values.help || !command || command === "help") {
    console.log(HELP);
    return;
  }
  if (existsSync(".env")) process.loadEnvFile(".env");
  const { config, markets, path } = loadConfig(values.config);

  switch (command) {
    case "scan":
      return scan(config, markets);
    case "backtest": {
      const days = Number(values.dias ?? 365);
      if (!(days > 0)) throw new Error("--dias debe ser un número positivo");
      return runBacktest(config, markets, { days, market: values.mercado, listTrades: values.operaciones });
    }
    case "status":
      return status(config, markets, values.reanudar);
    case "run":
    case "bot":
      return run(config, markets, path, values.once);
    default:
      throw new Error(`Comando desconocido: ${command}\n\n${HELP}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  },
);
