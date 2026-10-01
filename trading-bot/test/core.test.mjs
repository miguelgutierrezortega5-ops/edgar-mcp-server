import assert from "node:assert/strict";
import { test } from "node:test";
import { atr, ema, rsi } from "../dist/indicators.js";
import { canOpen, newRiskState, positionSize, updateRisk } from "../dist/risk.js";
import { checkStops, trailStop } from "../dist/stops.js";
import { computeIndicators, evaluate, minCandles } from "../dist/strategy.js";
import { aggregate, closedCandles, mergeCandles } from "../dist/timeframes.js";
import { bars, FAST, HOUR, RISK, T0, vShape } from "./helpers.mjs";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test("ema seeds with the simple average and then smooths", () => {
  const out = ema([1, 2, 3, 4, 5, 6], 3);
  assert.ok(Number.isNaN(out[0]) && Number.isNaN(out[1]));
  // k = 0.5: 2, then 4*.5+2*.5 = 3, 4, 5
  assert.deepEqual(out.slice(2), [2, 3, 4, 5]);
  assert.deepEqual(ema([7, 7, 7, 7], 2).slice(1), [7, 7, 7]);
});

test("rsi matches Wilder's worked example", () => {
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64];
  const out = rsi(closes, 14);
  assert.ok(Number.isNaN(out[13]));
  // Same values as TA-Lib; StockCharts' published table (70.53…) rounds its intermediate averages.
  const expected = [70.46, 66.25, 66.48, 69.35, 66.29, 57.92];
  expected.forEach((v, i) => close(out[14 + i], v, 0.01));
  assert.equal(rsi([1, 2, 3, 4, 5], 3)[4], 100);
  assert.equal(rsi([5, 5, 5, 5], 2)[3], 50);
});

test("atr averages the true range, including gaps", () => {
  const candles = [
    { time: 0, open: 10, high: 11, low: 9, close: 10, volume: 0 },
    { time: 1, open: 10, high: 11, low: 9, close: 10, volume: 0 },
    { time: 2, open: 10, high: 11, low: 9, close: 10, volume: 0 },
    { time: 3, open: 14, high: 15, low: 13, close: 14, volume: 0 }, // gap: TR = 15 - 10 = 5
  ];
  const out = atr(candles, 2);
  assert.equal(out[2], 2);
  assert.equal(out[3], (2 * 1 + 5) / 2);
});

test("closedCandles drops bars still forming; mergeCandles replaces overlaps", () => {
  const b = bars([1, 2, 3]);
  assert.equal(closedCandles(b, "1h", T0 + 2 * HOUR + 10).length, 2);
  assert.equal(closedCandles(b, "1h", T0 + 3 * HOUR).length, 3);
  const merged = mergeCandles(b, [{ ...b[2], close: 9 }, { ...b[2], time: T0 + 3 * HOUR }], 3);
  assert.deepEqual(merged.map((c) => c.time), [T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR]);
  assert.equal(merged[1].close, 9);
});

test("aggregate builds UTC-aligned higher timeframes", () => {
  const four = aggregate(bars([1, 2, 3, 4, 5], T0 + HOUR), 4 * HOUR);
  assert.equal(four.length, 2);
  assert.equal(four[0].time, T0);
  assert.equal(four[0].open, 1);
  assert.equal(four[0].close, 3);
  assert.equal(four[1].time, T0 + 4 * HOUR);
});

const ind = (o) => ({ candles: o.close.map((c) => ({ close: c })), ...o });

test("evaluate enters long on a bullish cross above the trend", () => {
  const sig = evaluate(ind({ close: [10, 12], fast: [9, 11], slow: [10, 10], trend: [8, 8], rsi: [50, 55], atr: [1, 1] }), 1, FAST, false);
  assert.deepEqual(sig.entry, { side: "long", stopDistance: 2, takeProfitDistance: 4 });
  assert.equal(sig.exitShort, true);
  assert.equal(sig.exitLong, false);
});

test("evaluate filters crosses against the trend, overbought RSI and disabled shorts", () => {
  const p = { ...FAST, rsiOverbought: 70, rsiOversold: 30 };
  const below = evaluate(ind({ close: [10, 12], fast: [9, 11], slow: [10, 10], trend: [13, 13], rsi: [50, 55], atr: [1, 1] }), 1, p, false);
  assert.equal(below.entry, null);
  assert.match(below.reason, /contra la tendencia/);
  const hot = evaluate(ind({ close: [10, 12], fast: [9, 11], slow: [10, 10], trend: [8, 8], rsi: [50, 75], atr: [1, 1] }), 1, p, false);
  assert.equal(hot.entry, null);
  assert.match(hot.reason, /sobrecomprado/);
  const down = ind({ close: [10, 8], fast: [11, 9], slow: [10, 10], trend: [12, 12], rsi: [50, 45], atr: [1, 1] });
  assert.equal(evaluate(down, 1, p, false).entry, null);
  assert.equal(evaluate(down, 1, p, false).exitLong, true);
  assert.equal(evaluate(down, 1, p, true).entry.side, "short");
  const noTp = evaluate(ind({ close: [10, 12], fast: [9, 11], slow: [10, 10], trend: [8, 8], rsi: [50, 55], atr: [1, 1] }), 1, { ...p, takeProfitAtr: 0 }, false);
  assert.equal(noTp.entry.takeProfitDistance, null);
});

test("evaluate waits for enough history", () => {
  const candles = bars(vShape()).slice(0, minCandles(FAST) - 2);
  const sig = evaluate(computeIndicators(candles, FAST), candles.length - 1, FAST, true);
  assert.equal(sig.entry, null);
  assert.match(sig.reason, /historial insuficiente/);
});

test("a V-shaped market produces a long entry on real indicators", () => {
  const candles = bars(vShape());
  const indicators = computeIndicators(candles, FAST);
  const entries = candles.map((_, i) => evaluate(indicators, i, FAST, false)).filter((s) => s.entry);
  assert.ok(entries.length >= 1);
  assert.equal(entries[0].entry.side, "long");
});

test("positionSize risks the configured share of equity, capped by position value", () => {
  // 1% of 10,000 over a 20-pip stop = 50,000 units; 500% notional cap at 1.1 = 45,454 units.
  close(positionSize({ equity: 10_000, price: 1.1, stopDistance: 0.002, rate: 1, type: "forex", params: RISK }), 10_000 * 5 / 1.1);
  close(positionSize({ equity: 10_000, price: 1.1, stopDistance: 0.005, rate: 1, type: "forex", params: RISK }), 20_000);
  // USD/JPY: the risk is in JPY, converted at 1/price.
  close(positionSize({ equity: 10_000, price: 150, stopDistance: 0.5, rate: 1 / 150, type: "forex", params: RISK }), 30_000);
  // Crypto: a 25% cap on 10,000 at 50,000 = 0.05 BTC, below the 1%-risk size of 0.1.
  close(positionSize({ equity: 10_000, price: 50_000, stopDistance: 1000, rate: 1, type: "crypto", params: RISK }), 0.05);
  assert.equal(positionSize({ equity: 0, price: 1, stopDistance: 1, rate: 1, type: "crypto", params: RISK }), 0);
});

test("risk limits: open positions, daily loss, drawdown breaker", () => {
  const state = newRiskState(10_000, T0);
  assert.deepEqual(canOpen(state, RISK, 10_000, 0), { ok: true });
  assert.equal(canOpen(state, RISK, 10_000, 4).ok, false);
  assert.match(canOpen(state, RISK, 9_650, 0).reason, /pérdida diaria/);
  // A new day resets the daily reference.
  updateRisk(state, RISK, 9_650, T0 + 25 * HOUR);
  assert.equal(canOpen(state, RISK, 9_650, 0).ok, true);
  // Peak 12,000 then -15% trips the breaker once.
  assert.equal(updateRisk(state, RISK, 12_000, T0 + 26 * HOUR), false);
  assert.equal(updateRisk(state, RISK, 10_200, T0 + 27 * HOUR), true);
  assert.equal(updateRisk(state, RISK, 10_000, T0 + 28 * HOUR), false);
  assert.match(canOpen(state, RISK, 12_000, 0).reason, /detenido/);
});

const pos = (side, stop, takeProfit) => ({ side, stop, takeProfit, entryPrice: 100, extreme: 100 });

test("checkStops: levels, gaps, and stop first when a bar hits both", () => {
  assert.equal(checkStops(pos("long", 95, 110), { open: 100, high: 105, low: 96 }), null);
  assert.deepEqual(checkStops(pos("long", 95, 110), { open: 100, high: 105, low: 94 }), { reason: "stop-loss", price: 95 });
  assert.deepEqual(checkStops(pos("long", 95, 110), { open: 92, high: 93, low: 90 }), { reason: "stop-loss", price: 92 });
  assert.deepEqual(checkStops(pos("long", 95, 110), { open: 100, high: 111, low: 94 }), { reason: "stop-loss", price: 95 });
  assert.deepEqual(checkStops(pos("long", 95, 110), { open: 100, high: 111, low: 99 }), { reason: "take-profit", price: 110 });
  assert.deepEqual(checkStops(pos("long", 95, null), { open: 100, high: 500, low: 99 }), null);
  assert.deepEqual(checkStops(pos("short", 105, 90), { open: 100, high: 106, low: 99 }), { reason: "stop-loss", price: 105 });
  assert.deepEqual(checkStops(pos("short", 105, 90), { open: 88, high: 89, low: 87 }), { reason: "take-profit", price: 88 });
});

test("trailStop only tightens", () => {
  const long = pos("long", 95, null);
  assert.equal(trailStop(long, { open: 100, high: 104, low: 99 }, 2, 2), 100);
  long.stop = 100;
  assert.equal(trailStop(long, { open: 101, high: 103, low: 100 }, 2, 2), null);
  const short = pos("short", 105, null);
  assert.equal(trailStop(short, { open: 100, high: 101, low: 97 }, 1, 2), 99);
  assert.equal(trailStop(short, { open: 100, high: 101, low: 97 }, 1, 0), null);
});
