#!/usr/bin/env node
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { unrealized } from "./brokers/broker.js";
import { simulate, type PortfolioResult, type SeriesInput } from "./backtest.js";
import { loadConfig, makeMarket, type Config } from "./config.js";
import { quoteRate, rateFunction } from "./data/source.js";
import { Bot, historyStart } from "./engine.js";
import * as fmt from "./fmt.js";
import { telegramCommands, telegramNotifier } from "./notify.js";
import { selectPairs } from "./pairs.js";
import { lookaheadCheck } from "./verify.js";
import { assess, collectOutcomes, describeArm, loadAdaptive, saveAdaptive, type AdaptiveState } from "./adaptive.js";
import { hurst, regimeName } from "./quant.js";
import { FuturesSource, openInterestChange, type FuturesPoint } from "./data/futures.js";
import { join } from "node:path";
import { buildBrokers, buildSources } from "./setup.js";
import { paperName, Store } from "./store.js";
import { applyLearning, describeLearning, learn, loadLearning, saveLearning } from "./learn.js";
import { eventStudy, features, footprintsAt, HORIZONS } from "./research.js";
import { minCandles, needsReference, referenceMarket, signalAt, strategyOf } from "./strategy.js";
import { closedCandles, TIMEFRAME_MS } from "./timeframes.js";
import type { Candle, ClosedTrade, Market, PriceMark } from "./types.js";

const HELP = `Bot de trading de criptomonedas y divisas

Uso: node dist/index.js <comando> [opciones]   (o npm run <comando> -- [opciones])

Comandos:
  scan                     Muestra el estado de cada mercado: tendencia, medias, RSI, volatilidad y señal
  backtest                 Prueba la estrategia con datos históricos
      --dias N             Días de historia (por defecto 365)
      --mercado SIMBOLO    Solo ese mercado, p. ej. BTC/USDT
      --operaciones        Lista cada operación
  estudiar                 Estudia las huellas de las ballenas (desplomes, bombeos, barridas de stops,
                           absorciones…) y qué hizo el precio después, con datos recientes
      --dias N             Días de historia (por defecto 30)
      --temporalidad 3m    Solo los mercados de esa temporalidad (por defecto la más usada)
  aprender                 Reajusta los parámetros con datos recientes y los valida en datos no vistos;
                           pausa los mercados donde ninguna configuración gana
  verificar                Comprueba que ninguna estrategia mira al futuro (sesgo de anticipación)
  run (o bot)              Arranca el bot: vigila los mercados, opera y vuelve a aprender cada 24 h
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
  applyLearning(markets, loadLearning(config.dataDir));
  const now = Date.now();
  const rows: string[][] = [];
  const refs = await referenceBars(config, markets, src, (m) => historyStart(m, config.historyBars, now), now);
  const fs = futuresSource(config);
  await Promise.all(
    markets.map(async (m, k) => {
      try {
        const candles = await src[m.type]!.history(m, historyStart(m, config.historyBars, now));
        const closed = closedCandles(candles, m.timeframe, now);
        const last = candles.at(-1)!;
        const dayAgo = [...candles].reverse().find((c) => c.time <= last.time - DAY);
        const ref = refs.get(m.timeframe);
        const f = features(closed, m.type === "crypto" ? ref : undefined);
        const recent = closed.length - 1;
        const prints: string[] = [];
        for (let i = recent; i > recent - 20 && i > 0; i--) for (const name of footprintsAt(f, i)) if (!prints.some((p) => p.startsWith(name))) prints.push(`${name} (hace ${recent - i + 1})`);
        const sig = closed.length >= minCandles(m) ? signalAt(m, closed, { reference: ref }) : null;
        rows[k] = [
          m.id,
          fmt.price(last.close),
          dayAgo ? fmt.pct((last.close / dayAgo.close - 1) * 100) : "—",
          Number.isFinite(f.relVolume[recent]) ? `×${f.relVolume[recent].toFixed(1)}` : "—",
          Number.isFinite(f.buyShare[recent]) ? `${(f.buyShare[recent] * 100).toFixed(0)}%` : "—",
          Number.isFinite(f.vpinPct[recent]) ? `p${(f.vpinPct[recent] * 100).toFixed(0)}` : "—",
          regimeName(hurst(closed, 300)),
          fs && m.type === "crypto" ? await futuresSummary(fs, m, now).catch((err) => `error: ${(err as Error).message}`) : "—",
          prints.slice(0, 2).join(", ") || "—",
          m.paused ? `en pausa: ${m.paused}` : !sig ? `solo ${closed.length} velas` : sig.entry ? `ENTRADA ${fmt.side(sig.entry.side).toUpperCase()}: ${sig.reason}` : sig.reason,
        ];
      } catch (err) {
        rows[k] = [m.id, "", "", "", "", "", "", "", "", `error: ${(err as Error).message}`];
      }
    }),
  );
  console.log(`Mercados a ${fmt.time(now)} UTC. Volumen y compras agresivas de la última vela cerrada; huellas de las últimas 20 velas\n`);
  console.log(fmt.table(["Mercado", "Precio", "24h", "Volumen", "Compras", "VPIN", "Régimen", "Futuros", "Huella de ballenas", "Señal"], rows));
  console.log("\nVPIN: toxicidad del flujo (p90 = más tóxico que el 90% del historial reciente). Régimen: exponente de Hurst de las últimas 300 velas.");
  if (fs) console.log("Futuros: cambio del interés abierto en 30 min, largos/cortos de los grandes traders (por posición) y de todas las cuentas, y última financiación.");
}

/** Binance futures positioning, when enabled and the exchange is Binance (archive cached in data/futuros). */
function futuresSource(config: Config): FuturesSource | null {
  return config.crypto.futures && config.crypto.exchange === "binance" ? new FuturesSource(join(config.dataDir, "futuros"), log) : null;
}

const futuresSymbol = (m: Market) => `${m.base}${m.quote}`;

/** One line about a market's futures positioning: open interest change, whales, crowd, funding. */
async function futuresSummary(fs: FuturesSource, m: Market, now: number): Promise<string> {
  const [points, funding] = await Promise.all([fs.metrics(futuresSymbol(m), now - 2 * DAY, now), fs.funding(futuresSymbol(m), now - 2 * DAY, now)]);
  const last = points.at(-1);
  if (!last) return "sin contrato";
  const oi = openInterestChange([{ time: last.time }], points, 0)[0];
  const age = now - last.time;
  const f = funding.at(-1);
  return [
    Number.isFinite(oi) ? `OI ${oi >= 0 ? "+" : ""}${oi.toFixed(1)}%` : null,
    `ballenas L/S ${last.topPositionsRatio.toFixed(2)}`,
    `multitud ${last.crowdRatio.toFixed(2)}`,
    f ? `fin ${(f.rate * 100).toFixed(3)}%` : null,
    age > 15 * 60_000 ? `(hace ${Math.round(age / 3_600_000)} h)` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Configured markets plus the pairs picked automatically from Binance (crypto.autoPairs). */
async function withAutoPairs(config: Config, manual: Market[]): Promise<Market[]> {
  const a = config.crypto.autoPairs;
  if (!a.enabled) return manual;
  if (config.crypto.exchange !== "binance") throw new Error("crypto.autoPairs solo funciona con Binance");
  const picks = await selectPairs(a);
  const markets = [...manual];
  for (const p of picks) {
    if (markets.some((m) => m.symbol === p.symbol && m.timeframe === a.timeframe)) continue;
    markets.push(makeMarket(config, "crypto", { symbol: p.symbol, timeframe: a.timeframe, strategy: a.strategy }, markets));
  }
  log(`Pares automáticos (${a.minVolumeUsd / 1e6}-${a.maxVolumeUsd / 1e6} M USD/día, spread ≤ ${a.maxSpreadPct}%, ≥ ${a.minAgeDays} días): ${picks.map((p) => `${p.symbol} ${(p.volumeUsd / 1e6).toFixed(1)}M ${p.spreadPct.toFixed(2)}%`).join(", ") || "ninguno"}`);
  return markets;
}

/** Closed bars of the reference market (BTC) for each timeframe that needs it. */
async function referenceBars(
  config: Config,
  markets: Market[],
  src: Partial<Record<"crypto" | "forex", { history(m: Market, since: number): Promise<Candle[]> }>>,
  since: (m: Market) => number,
  now: number,
  always = false,
): Promise<Map<string, Candle[]>> {
  const out = new Map<string, Candle[]>();
  for (const m of markets) {
    if ((!always && !needsReference(m)) || m.type !== "crypto" || out.has(m.timeframe) || !src.crypto) continue;
    const ref = referenceMarket(config.crypto.reference, m);
    try {
      out.set(m.timeframe, closedCandles(await src.crypto.history(ref, since(m)), m.timeframe, now));
    } catch (err) {
      log(`${ref.id}: ${(err as Error).message}`);
    }
  }
  return out;
}

async function verify(config: Config, markets: Market[]): Promise<void> {
  const { sources: src } = buildSources(config, markets);
  const now = Date.now();
  let failed = 0;
  for (const m of markets) {
    try {
      const since = historyStart(m, config.historyBars * 2, now);
      const candles = closedCandles(await src[m.type]!.history(m, since), m.timeframe, now);
      const reference = (await referenceBars(config, [m], src, () => since, now)).get(m.timeframe);
      const r = lookaheadCheck({ strategy: strategyOf(m), params: m.strategy, allowShort: m.allowShort, candles, context: { reference } });
      if (r.mismatches.length) failed++;
      console.log(`${r.mismatches.length ? "✗" : "✓"} ${m.id} (${strategyOf(m).name}): ${r.checked} velas comprobadas, ${r.mismatches.length} discrepancias`);
      for (const x of r.mismatches.slice(0, 3)) console.log(`    ${fmt.time(x.time)}: con todo el historial ${x.full}, cortado ${x.cut}`);
    } catch (err) {
      console.log(`? ${m.id}: ${(err as Error).message}`);
    }
  }
  console.log(failed ? `\n${failed} mercados con sesgo de anticipación: sus backtests no son fiables.` : "\nNinguna estrategia mira al futuro.");
}

async function study(config: Config, markets: Market[], days: number, timeframe?: string): Promise<void> {
  const fs = futuresSource(config);
  // Horizons are counted in bars, so only pool markets of the same timeframe (the most used one).
  const crypto = markets.filter((m) => m.type === "crypto");
  const pool = crypto.length ? crypto : markets;
  const counts = new Map<string, number>();
  pool.forEach((m) => counts.set(m.timeframe, (counts.get(m.timeframe) ?? 0) + 1));
  const tf = timeframe ?? [...counts].sort((a, b) => b[1] - a[1])[0][0];
  const list = pool.filter((m) => m.timeframe === tf);
  if (!list.length) throw new Error(`No hay mercados de ${tf}`);
  const { sources: src } = buildSources(config, list);
  const now = Date.now();
  const series = (
    await Promise.all(
      list.map(async (m) => {
        try {
          const futures = fs && m.type === "crypto" ? await fs.metrics(futuresSymbol(m), now - days * DAY, now).catch(() => undefined) : undefined;
          return { id: m.id, candles: closedCandles(await src[m.type]!.history(m, now - days * DAY), m.timeframe, now), futures };
        } catch (err) {
          log(`${m.id}: ${(err as Error).message}`);
          return null;
        }
      }),
    )
  ).filter((x): x is { id: string; candles: Candle[]; futures: FuturesPoint[] | undefined } => x !== null);
  const ref = list[0].type === "crypto" ? (await referenceBars(config, list, src, () => now - days * DAY, now, true)).get(tf) : undefined;
  const { stats, baseline } = eventStudy(series, ref);
  const cost = (config.paper.cryptoFeePct + config.paper.cryptoSlippagePct) * 2;
  const r = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}` : "—");
  console.log(`Estudio de huellas: ${series.length} mercados de ${tf}, ${days} días. Rentabilidad media (%) desde la apertura siguiente hasta ${HORIZONS.join(", ")} velas después.`);
  console.log(`Referencia (todas las velas): ${baseline.map(r).join(" / ")}. Coste de ida y vuelta simulado: ${cost.toFixed(2)}%\n`);
  console.log(
    fmt.table(
      ["Huella", "Casos", `+${HORIZONS.join(" / +")} velas`, "Sube a +20", "1ª mitad", "2ª mitad", "Mercados +"],
      stats.map((s) => [s.pattern.name, String(s.events), s.mean.map(r).join(" / "), `${s.hitRate.toFixed(0)}%`, r(s.firstHalf), r(s.secondHalf), `${s.marketsPositive}/${s.markets}`]),
    ),
  );
  console.log("\n" + stats.map((s) => `${s.pattern.name}: ${s.pattern.meaning}`).join("\n"));
  console.log("\nUna huella es útil si su media supera el coste, se repite en ambas mitades y en la mayoría de mercados.");
}

/** Score every recent signal's outcome per strategy and context, and save the size multipliers. */
async function runAdaptive(config: Config, markets: Market[], notify?: (msg: string) => Promise<void>): Promise<AdaptiveState> {
  const { sources: src, fx } = buildSources(config, markets);
  const now = Date.now();
  const from = now - config.adaptive.windowDays * DAY;
  const fs = futuresSource(config);
  const loaded = await Promise.all(
    markets.map(async (m): Promise<(SeriesInput & { futures?: FuturesPoint[] }) | null> => {
      try {
        const since = historyStart(m, minCandles(m) * 3, from);
        const candles = closedCandles(await src[m.type]!.history(m, since), m.timeframe, now);
        const reference = (await referenceBars(config, [m], src, () => since, now)).get(m.timeframe);
        const futures = fs && m.type === "crypto" ? await fs.metrics(futuresSymbol(m), since, now).catch(() => undefined) : undefined;
        return { market: m, candles, rateAt: await rateFunction(m, config.accountCurrency, fx, candles.at(-1)?.close ?? 1), context: { reference }, futures };
      } catch (err) {
        log(`Capa adaptativa ${m.id}: ${(err as Error).message}`);
        return null;
      }
    }),
  );
  const previous = loadAdaptive(config.dataDir);
  const state = assess(collectOutcomes(loaded.filter((x): x is SeriesInput & { futures?: FuturesPoint[] } => x !== null), { risk: config.risk, costs: config.paper, from }), now, config.adaptive);
  saveAdaptive(config.dataDir, state);
  state.arms.forEach((a) => log(`Evidencia ${describeArm(a)}`));
  const switched = state.arms.filter((a) => {
    const before = previous?.arms.find((b) => b.group === a.group && b.context === a.context);
    return before && before.scale > 0 !== a.scale > 0;
  });
  if (switched.length) await notify?.(`📊 Capa adaptativa:\n${switched.map((a) => `${a.scale > 0 ? "▶️ vuelve" : "⏹️ se apaga"} ${a.group} | ${a.context}`).join("\n")}`);
  return state;
}

async function runLearning(config: Config, markets: Market[], notify?: (msg: string) => Promise<void>): Promise<void> {
  const { sources: src, fx } = buildSources(config, markets);
  log(`Aprendiendo con ${markets.length} mercados (puede tardar un par de minutos)…`);
  applyLearning(markets, loadLearning(config.dataDir)); // the current parameters are the last learned ones
  const state = await learn({ markets, config, fx, history: (m, since) => src[m.type]!.history(m, since), now: Date.now(), log });
  saveLearning(config.dataDir, state);
  const changes = applyLearning(markets, state);
  const lines = describeLearning(state, config.accountCurrency);
  lines.forEach((l) => log(l));
  changes.forEach((l) => log(l));
  await notify?.(`🧠 Aprendizaje:\n${state.groups.map((g) => `${g.key}: ${g.decision} — ${g.note}`).join("\n")}`);
  if (config.adaptive.enabled) await runAdaptive(config, markets, notify);
}

async function runBacktest(config: Config, markets: Market[], opts: { days: number; market?: string; listTrades: boolean }): Promise<void> {
  const selected = opts.market ? markets.filter((m) => m.symbol === opts.market!.toUpperCase() || m.id.toUpperCase() === opts.market!.toUpperCase()) : markets;
  if (!selected.length) throw new Error(`No hay ningún mercado ${opts.market} en la configuración`);
  const { sources: src, fx } = buildSources(config, selected);
  const now = Date.now();
  const tradeFrom = now - opts.days * DAY;
  const ccy = config.accountCurrency;
  const loaded = await Promise.all(
    selected.map(async (m): Promise<SeriesInput | null> => {
      try {
        const since = historyStart(m, minCandles(m) * 3, tradeFrom);
        const candles = closedCandles(await src[m.type]!.history(m, since), m.timeframe, now);
        if (candles.length && candles[0].time > tradeFrom) log(`${m.id}: la fuente solo da historia desde ${fmt.time(candles[0].time)}; el backtest es más corto de lo pedido`);
        const rateAt = await rateFunction(m, ccy, fx, candles.at(-1)?.close ?? 1);
        const reference = (await referenceBars(config, [m], src, () => since, now)).get(m.timeframe);
        return { market: m, candles, rateAt, context: { reference } };
      } catch (err) {
        log(`${m.id}: ${(err as Error).message}`);
        return null;
      }
    }),
  );
  const all = loaded.filter((x): x is SeriesInput => x !== null);
  for (const type of ["crypto", "forex"] as const) {
    const series = all.filter((x) => x.market.type === type);
    if (series.length) report(config, simulate({ series, risk: config.risk, costs: config.paper, startingBalance: config.paper.startingBalance, tradeFrom, protections: config.protections }), type, opts.listTrades);
  }
  console.log(
    "\nOjo: un backtest no garantiza resultados futuros. Incluye comisiones, deslizamiento y spread simulados, pero no la profundidad real del libro de órdenes, " +
      "caídas del exchange ni el coste de financiación de las posiciones apalancadas de divisas.",
  );
}

function report(config: Config, r: PortfolioResult, type: "crypto" | "forex", listTrades: boolean): void {
  const ccy = config.accountCurrency;

  const pf = (v: number) => (Number.isNaN(v) ? "—" : v === Infinity ? "∞" : v.toFixed(2));
  const sum = (ts: ClosedTrade[]) => ts.reduce((a, t) => a + t.pnl, 0);
  console.log(`\nBacktest de la cuenta de ${type === "crypto" ? "cripto" : "divisas"}: ${fmt.money(config.paper.startingBalance, ccy)} compartidos por sus mercados, como en el bot (máx. ${config.risk.maxOpenPositions} posiciones, riesgo ${config.risk.riskPerTradePct}% por operación, protecciones activas)\n`);
  console.log(
    fmt.table(
      ["Mercado", "Desde", "Ops", "Aciertos", "F. beneficio", "Resultado", "Comprar y mantener", "Exposición"],
      r.markets.map((m) => {
        const wins = m.trades.filter((t) => t.pnl > 0);
        const gl = -m.trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
        const gw = sum(wins);
        return [
          m.market.id,
          fmt.time(m.from).slice(0, 10),
          String(m.trades.length),
          m.trades.length ? `${((wins.length / m.trades.length) * 100).toFixed(0)}%` : "—",
          pf(gl > 0 ? gw / gl : gw > 0 ? Infinity : NaN),
          fmt.money(sum(m.trades), ccy),
          fmt.pct(m.buyHoldPct),
          `${m.exposurePct.toFixed(0)}%`,
        ];
      }),
    ),
  );
  console.log(
    `\nTotal: ${r.trades.length} operaciones, aciertos ${Number.isNaN(r.winRatePct) ? "—" : r.winRatePct.toFixed(0) + "%"}, factor de beneficio ${pf(r.profitFactor)}, ` +
      `resultado ${fmt.money(r.endEquity - r.startEquity, ccy)} (${fmt.pct(r.returnPct)}), caída máxima -${r.maxDrawdownPct.toFixed(1)}%, comisiones ${fmt.money(r.fees, ccy)}.`,
  );
  console.log(`Señales no operadas por el límite de posiciones o las protecciones: ${r.skipped}.`);
  if (r.halted) console.log(`Se detuvo por ${r.halted}`);

  if (listTrades) {
    for (const m of r.markets.filter((x) => x.trades.length)) {
      console.log(`\n${m.market.id}`);
      console.log(
        fmt.table(
          ["Entrada", "Salida", "Lado", "Precio entrada", "Precio salida", "Resultado", "Motivo"],
          m.trades.map((t) => [fmt.time(t.openedAt), fmt.time(t.closedAt), fmt.side(t.side), fmt.price(t.entryPrice), fmt.price(t.exitPrice), fmt.money(t.pnl, ccy), t.reason]),
        ),
      );
    }
  }
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

  for (const type of ["crypto", "forex"] as const) {
    const book = state.papers[type];
    const value = state.positions.filter((p) => p.broker === paperName(type)).reduce((s, p) => s + unrealized(p, marks.get(p.marketId)), book.balance);
    console.log(`Cuenta simulada de ${type === "crypto" ? "cripto" : "divisas"}: saldo ${fmt.money(book.balance, ccy)}, valor con posiciones ${fmt.money(value, ccy)} (${fmt.pct((value / book.startingBalance - 1) * 100)} desde ${fmt.money(book.startingBalance, ccy)})`);
  }

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

  const learned = loadLearning(config.dataDir);
  console.log(`\nAprendizaje${learned ? ` (${fmt.time(learned.updatedAt)} UTC; historial en ${config.dataDir}/aprendizaje.log)` : ": todavía no se ha ejecutado (npm run aprender)"}`);
  if (learned) describeLearning(learned, ccy).forEach((l) => console.log(`  ${l}`));
  const adaptive = loadAdaptive(config.dataDir);
  console.log(`\nCapa adaptativa${adaptive ? ` (${fmt.time(adaptive.updatedAt)} UTC; historial en ${config.dataDir}/adaptativo.log)` : ": sin datos todavía"}`);
  adaptive?.arms.forEach((a) => console.log(`  ${describeArm(a)}`));

  console.log("\nLímites de riesgo");
  for (const [name, r] of Object.entries(state.risk)) {
    console.log(`  ${name}: máximo ${fmt.money(r.peakEquity, ccy)}, inicio del día ${fmt.money(r.dayStartEquity, ccy)} (${r.day})${r.halted ? ` — DETENIDO: ${r.halted}` : ""}`);
  }
}

async function run(config: Config, manual: Market[], markets: Market[], path: string, once: boolean): Promise<void> {
  const store = new Store(config.dataDir);
  const state = store.load(config.paper.startingBalance);
  const { sources: src, fx } = buildSources(config, markets);
  const brokers = buildBrokers(config, markets, state);
  const notify = telegramNotifier(config.telegram.enabled, log);
  const learning = config.learning;
  const relearn = async () => {
    const last = loadLearning(config.dataDir);
    const age = last ? Date.now() - last.updatedAt : Infinity;
    if (age < learning.everyHours * 3_600_000) return;
    // Learning takes minutes and pauses the loop: wait until no position needs watching (up to a day late).
    if (state.positions.length && age < (learning.everyHours + 24) * 3_600_000) return;
    try {
      await runLearning(config, markets, notify);
    } catch (err) {
      log(`Aprendizaje fallido: ${(err as Error).message}`);
    }
  };
  applyLearning(markets, loadLearning(config.dataDir)).forEach((l) => log(l));
  let pairsAt = Date.now();
  const auto = config.crypto.autoPairs;
  const beforeTick = async () => {
    if (auto.enabled && Date.now() - pairsAt >= auto.refreshHours * 3_600_000) {
      pairsAt = Date.now();
      try {
        const fresh = await withAutoPairs(config, manual);
        applyLearning(fresh, loadLearning(config.dataDir));
        const changes = await bot.setMarkets(fresh);
        if (changes.length) {
          log(`Lista de pares actualizada: ${changes.join(", ")}`);
          await notify(`🔄 Pares: ${changes.join(", ")}`);
        }
      } catch (err) {
        log(`No se pudo actualizar la lista de pares: ${(err as Error).message}`);
      }
    }
    if (learning.enabled) await relearn();
    const age = adaptiveState ? Date.now() - adaptiveState.updatedAt : Infinity;
    if (config.adaptive.enabled && age >= config.adaptive.everyHours * 3_600_000 && (!state.positions.length || age >= (config.adaptive.everyHours + 4) * 3_600_000)) {
      try {
        adaptiveState = await runAdaptive(config, bot.markets, notify);
      } catch (err) {
        log(`Capa adaptativa fallida: ${(err as Error).message}`);
      }
    }
  };
  let adaptiveState = config.adaptive.enabled ? loadAdaptive(config.dataDir) : null;
  const fsLive = futuresSource(config);
  const futuresFor = fsLive ? (m: Market, since: number) => fsLive.metrics(futuresSymbol(m), since) : undefined;
  const bot = new Bot({ config, markets, sources: src, brokers, fx, store, state, notify, log, beforeTick, commands: telegramCommands(config.telegram.enabled, log), adaptive: () => adaptiveState, futures: futuresFor });

  log(`Configuración: ${path}. Revisión cada ${config.pollSeconds} s.`);
  for (const m of markets) {
    const b = brokers[m.type]!;
    const mode = b.realMoney ? "DINERO REAL" : b.name.startsWith("paper") ? "simulado" : "cuenta de pruebas";
    log(`  ${m.id.padEnd(14)} → ${b.name} (${mode}), ${strategyOf(m).name}${m.allowShort ? ", largos y cortos" : ", solo largos"}${m.paused ? " — en pausa" : ""}`);
  }
  if (once) {
    await beforeTick();
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
      temporalidad: { type: "string" },
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
  const { config, markets: manual, path } = loadConfig(values.config);
  const markets = await withAutoPairs(config, manual);
  if (!markets.length) throw new Error("No hay mercados: añádelos en la configuración o activa crypto.autoPairs");

  switch (command) {
    case "scan":
      return scan(config, markets);
    case "backtest": {
      const days = Number(values.dias ?? 365);
      if (!(days > 0)) throw new Error("--dias debe ser un número positivo");
      return runBacktest(config, markets, { days, market: values.mercado, listTrades: values.operaciones });
    }
    case "estudiar": {
      const days = Number(values.dias ?? 30);
      if (!(days > 0)) throw new Error("--dias debe ser un número positivo");
      return study(config, markets, days, values.temporalidad);
    }
    case "verificar":
      return verify(config, markets);
    case "aprender":
      return runLearning(config, markets);
    case "status":
      return status(config, markets, values.reanudar);
    case "run":
    case "bot":
      return run(config, manual, markets, path, values.once);
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
