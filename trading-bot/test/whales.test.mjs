import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { backtest } from "../dist/backtest.js";
import { parseConfig } from "../dist/config.js";
import { BinanceSource } from "../dist/data/binance.js";
import { applyLearning, combinations, learn, loadLearning, saveLearning, stats } from "../dist/learn.js";
import { eventStudy, features, footprintsAt } from "../dist/research.js";
import { averageBarValue, positionSize } from "../dist/risk.js";
import { capitulation, referenceMove, relativeVolume } from "../dist/strategies/capitulation.js";
import { signalAt } from "../dist/strategy.js";
import { COSTS, RISK, T0 } from "./helpers.mjs";

const M3 = 3 * 60_000;
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

/** Quiet 3m market with an optional flush: -6% in 10 bars on 10x volume, then a full rebound. */
function flushMarket({ flushAt = 300, length = 420, rebound = true } = {}) {
  const out = [];
  let price = 100;
  for (let i = 0; i < length; i++) {
    const open = price;
    if (flushAt !== null && i > flushAt - 10 && i <= flushAt) price *= 0.994;
    else if (flushAt !== null && rebound && i > flushAt && i <= flushAt + 10) price *= 1.006;
    else price *= 1 + (i % 2 ? 0.0005 : -0.0005);
    const climax = i === flushAt; // capitulation volume concentrates at the bottom
    out.push({ time: T0 + i * M3, open, high: Math.max(open, price) * 1.0005, low: Math.min(open, price) * 0.9995, close: price, volume: climax ? 10_000 : 1_000, takerBuy: climax ? 2_000 : 500 });
  }
  return out;
}
const capMarket = (params = {}) => ({ id: "ALT/USDT 3m", type: "crypto", symbol: "ALT/USDT", base: "ALT", quote: "USDT", timeframe: "3m", allowShort: false, strategyName: "capitulacion", strategy: { ...capitulation.defaults, ...params } });
const btc = (dropAt, drop = true) => flushMarket({ flushAt: drop ? dropAt : null }).map((c) => ({ ...c, close: c.close * 800, open: c.open * 800, high: c.high * 800, low: c.low * 800 }));

test("relativeVolume and referenceMove look only backwards", () => {
  const c = flushMarket();
  const rv = relativeVolume(c, 50);
  assert.ok(Number.isNaN(rv[49]));
  assert.equal(rv[100], 1);
  assert.equal(rv[300], 10);
  const ref = referenceMove(c, c, 10);
  assert.ok(Number.isNaN(ref[5]));
  assert.ok(Math.abs(ref[300] - ((c[300].close / c[290].close - 1) * 100)) < 1e-9);
  assert.ok(referenceMove(c, undefined, 10).every(Number.isNaN));
});

test("capitulation buys a flush only when the whole market falls with it", () => {
  const candles = flushMarket().slice(0, 301);
  const m = capMarket();
  const cascade = signalAt(m, candles, { reference: btc(300) });
  assert.equal(cascade.entry.side, "long");
  assert.equal(cascade.entry.maxBars, 40);
  const low = Math.min(...candles.slice(290).map((c) => c.low));
  assert.ok(Math.abs(cascade.entry.stopDistance - (candles[300].close - (low - 1.5 * cascade.atr))) < 1e-9);
  assert.ok(Math.abs(cascade.entry.takeProfitDistance - (candles[290].close - candles[300].close)) < 1e-9);

  const isolated = signalAt(m, candles, { reference: btc(300, false) });
  assert.equal(isolated.entry, null);
  assert.match(isolated.reason, /aislado/);
  assert.equal(signalAt(m, candles).entry, null); // no reference data: no trade
  assert.equal(signalAt(capMarket({ marketDropPct: 0 }), candles).entry.side, "long"); // filter off
  assert.equal(signalAt(m, flushMarket().slice(0, 250), { reference: btc(300) }).entry, null);
});

test("capitulation fades pumps only where shorting is allowed", () => {
  const pump = flushMarket().slice(0, 301).map((c) => ({ ...c, close: 200 - c.close, open: 200 - c.open, high: 200 - c.low, low: 200 - c.high }));
  const up = btc(300).map((c) => ({ ...c, close: 160_000 - c.close }));
  assert.equal(signalAt(capMarket({ marketDropPct: 0 }), pump).entry, null);
  assert.match(signalAt(capMarket({ marketDropPct: 0 }), pump).reason, /bombeo/);
  const short = signalAt({ ...capMarket({ marketDropPct: 0 }), allowShort: true }, pump, { reference: up });
  assert.equal(short.entry.side, "short");
});

test("backtest: the flush trade hits its target, a stalled one exits at the time stop", () => {
  const m = capMarket({ marketDropPct: 0 });
  const opts = { market: m, risk: RISK, costs: COSTS, startingBalance: 10_000, rateAt: () => 1 };
  const win = backtest({ ...opts, candles: flushMarket() });
  assert.equal(win.trades.length, 1);
  assert.equal(win.trades[0].reason, "take-profit");
  assert.ok(win.trades[0].pnl > 0);
  const stall = backtest({ ...opts, candles: flushMarket({ rebound: false }) });
  assert.equal(stall.trades[0].reason, "tiempo máximo");
  assert.equal(stall.trades[0].closedAt - stall.trades[0].openedAt, 40 * M3);
});

test("liquidity cap: a position never exceeds the set share of a typical bar's traded value", () => {
  const candles = [{ volume: 1000, close: 2 }, { volume: 3000, close: 2 }];
  assert.equal(averageBarValue(candles), 4000);
  const units = positionSize({ equity: 100_000, price: 2, stopDistance: 0.1, rate: 1, type: "crypto", params: RISK, barValue: 4000 });
  assert.equal(units, (4000 * 0.2) / 2);
  // Without the cap, the 1% risk limit binds (1,000 / 0.1 = 10,000 units, below the 25% value cap of 12,500).
  assert.equal(positionSize({ equity: 100_000, price: 2, stopDistance: 0.1, rate: 1, type: "crypto", params: { ...RISK, maxBarVolumePct: 0 }, barValue: 4000 }), 10_000);
});

test("footprints and the event study see the flush and its rebound", () => {
  const candles = flushMarket();
  const f = features(candles, btc(300));
  assert.ok(footprintsAt(f, 300).includes("desplome"));
  assert.ok(footprintsAt(f, 300).includes("desplome en cascada"));
  assert.ok(!footprintsAt(f, 300).includes("desplome aislado"));
  assert.ok(footprintsAt(f, 300).includes("absorción de ventas") === false); // closes at the low
  const { stats: s, baseline } = eventStudy([{ id: "A", candles }], btc(300));
  const flush = s.find((x) => x.pattern.name === "desplome");
  assert.equal(flush.events, 1);
  assert.ok(flush.mean[1] > 3 && flush.hitRate === 100);
  assert.equal(baseline.length, 4);
});

test("learning statistics count crash days once, and the grid expands", () => {
  const t = (day, pnl) => ({ openedAt: T0 + day * 86_400_000, pnl });
  const s = stats([t(0, 10), t(0, 10), t(0, 10), t(1, -5), t(2, 5)]);
  assert.equal(s.trades, 5);
  assert.equal(s.days, 3);
  assert.equal(s.pnl, 30);
  assert.equal(s.profitFactor, 7);
  const daily = [30, -5, 5];
  const mean = 10;
  const sd = Math.sqrt(daily.reduce((a, x) => a + (x - mean) ** 2, 0) / 2);
  assert.ok(Math.abs(s.tStat - (mean / sd) * Math.sqrt(3)) < 1e-9);
  assert.equal(combinations({ a: [1, 2], b: [3, 4, 5] }).length, 6);
  assert.deepEqual(combinations({}), [{}]);
});

test("learn adopts, keeps or pauses, and applyLearning acts on the markets", async () => {
  const { config, markets } = parseConfig({ crypto: { markets: [{ symbol: "ALT/USDT", timeframe: "3m", strategy: "capitulacion" }] }, learning: { bars: 2000, minTrades: 5 } });
  // A market where nothing ever happens: no trades → not enough evidence → parameters kept, not paused.
  const quiet = flushMarket({ flushAt: null, length: 3000 }).map((c, i) => ({ ...c, time: Date.now() - (3000 - i) * M3 }));
  const state = await learn({ markets, config, fx: { rate: async () => 1 }, history: async () => quiet, now: Date.now(), log: () => {} });
  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0].decision, "sin muestra");
  assert.equal(applyLearning(markets, state).length, 0);
  assert.equal(markets[0].paused, undefined);

  const dir = mkdtempSync(join(tmpdir(), "learn-"));
  dirs.push(dir);
  saveLearning(dir, { ...state, groups: [{ ...state.groups[0], decision: "pausa", note: "sin ventaja" }] });
  assert.equal(applyLearning(markets, loadLearning(dir))[0], "ALT/USDT 3m: en pausa (sin ventaja)");
  assert.equal(markets[0].paused, "sin ventaja");
  applyLearning(markets, { ...state, groups: [{ ...state.groups[0], decision: "nuevos", params: { dropPct: 5 } }] });
  assert.equal(markets[0].paused, undefined);
  assert.equal(markets[0].strategy.dropPct, 5);
  assert.equal(markets[0].strategy.relVolume, 4);
});

test("Binance source keeps taker-buy volume and pages through history", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const start = Number(new URL(url).searchParams.get("startTime"));
    const n = start === T0 ? 1000 : 3;
    const rows = Array.from({ length: n }, (_, i) => [start + i * M3, "1", "2", "0.5", "1.5", "100", 0, "150", 7, "60", "90", "0"]);
    return new Response(JSON.stringify(rows), { status: 200 });
  };
  const candles = await new BinanceSource().history({ base: "ALT", quote: "USDT", timeframe: "3m" }, T0);
  assert.equal(candles.length, 1003);
  assert.deepEqual(candles[0], { time: T0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100, takerBuy: 60 });
  assert.match(calls[0], /symbol=ALTUSDT&interval=3m/);
  assert.equal(calls.length, 2);
});

test("config: per-market strategies, parameter checks and 3m limits", () => {
  const { markets } = parseConfig({
    strategies: { capitulacion: { dropPct: 4 } },
    crypto: { markets: [{ symbol: "APE/USDT", timeframe: "3m", strategy: "capitulacion", params: { stopAtr: 2 } }] },
  });
  assert.equal(markets[0].strategyName, "capitulacion");
  assert.equal(markets[0].strategy.dropPct, 4);
  assert.equal(markets[0].strategy.stopAtr, 2);
  assert.equal(markets[0].strategy.marketDropPct, 0.5);
  assert.throws(() => parseConfig({ crypto: { markets: [{ symbol: "APE/USDT", strategy: "capitulacion", params: { fastEma: 3 } }] } }), /desconocidos/);
  assert.throws(() => parseConfig({ forex: { markets: [{ symbol: "EUR/USD", timeframe: "3m" }] } }), /3m/);
});
