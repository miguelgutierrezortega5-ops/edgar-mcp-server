import assert from "node:assert/strict";
import { test } from "node:test";
import { assess, scaleFor } from "../dist/adaptive.js";
import { dailyResults } from "../dist/learn.js";
import { amihud, decayedEvidence, deflatedSharpe, hurst, kyleLambda, logReturns, normCdf, normInv, vpin } from "../dist/quant.js";
import { T0 } from "./helpers.mjs";

const DAY = 86_400_000;
let seed = 11;
const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
const gauss = () => Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random());
const series = (steps) => {
  let p = 100;
  return steps.map((s, i) => ({ time: T0 + i * 60_000, open: p, high: p, low: p, close: (p *= Math.exp(s)), volume: 1000, takerBuy: 500 }));
};

test("normal distribution helpers", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-4);
  for (const p of [0.01, 0.2, 0.5, 0.9, 0.999]) assert.ok(Math.abs(normCdf(normInv(p)) - p) < 1e-6);
});

test("log returns add up; Hurst tells random walks from trends and mean reversion", () => {
  const c = series([0.01, -0.02, 0.03]);
  assert.ok(Math.abs(logReturns(c).reduce((a, b) => a + b, 0) - Math.log(c.at(-1).close / c[0].close)) < 1e-12);
  const walk = hurst(series(Array.from({ length: 3000 }, () => gauss() * 0.01)), 3000);
  assert.ok(Math.abs(walk - 0.5) < 0.08, `random walk H=${walk}`);
  let prev = 0;
  const trending = hurst(series(Array.from({ length: 3000 }, () => (prev = 0.8 * prev + gauss() * 0.01))), 3000);
  assert.ok(trending > 0.55, `persistent H=${trending}`);
  let lvl = 0;
  const reverting = hurst(series(Array.from({ length: 3000 }, () => { const s = -0.5 * lvl + gauss() * 0.01; lvl += s; return s; })), 3000);
  assert.ok(reverting < 0.45, `anti-persistent H=${reverting}`);
});

test("VPIN is 0 for balanced flow and 1 for one-sided flow; Kyle and Amihud measure impact", () => {
  const balanced = series(Array(200).fill(0));
  assert.equal(vpin(balanced, 1000, 10).at(-1), 0);
  const oneSided = balanced.map((c) => ({ ...c, takerBuy: 1000 }));
  assert.equal(vpin(oneSided, 1000, 10).at(-1), 1);
  assert.ok(Number.isNaN(vpin(balanced, 1000, 10)[5]));
  // Price moves exactly with net buying: positive impact.
  const flow = Array.from({ length: 200 }, () => random() * 1000);
  let p = 100;
  const impact = flow.map((b, i) => ({ time: i, open: p, high: p, low: p, close: (p *= Math.exp((2 * b - 1000) * 1e-6)), volume: 1000, takerBuy: b }));
  assert.ok(kyleLambda(impact, 60).at(-1) > 0);
  const thin = amihud(series(Array(100).fill(0.01)).map((c) => ({ ...c, volume: 1 })), 60).at(-1);
  const deep = amihud(series(Array(100).fill(0.01)), 60).at(-1);
  assert.ok(thin > deep * 100);
});

test("decayed evidence forgets: a pattern that stops working loses its weight", () => {
  const good = Array.from({ length: 30 }, (_, i) => ({ time: T0 + i * DAY, value: 0.01 + gauss() * 0.005 }));
  const bad = Array.from({ length: 30 }, (_, i) => ({ time: T0 + (30 + i) * DAY, value: -0.01 + gauss() * 0.005 }));
  const early = decayedEvidence(good, T0 + 30 * DAY, 10 * DAY);
  assert.ok(early.pPositive > 0.99 && early.kelly > 0);
  const later = decayedEvidence([...good, ...bad], T0 + 60 * DAY, 10 * DAY);
  assert.ok(later.pPositive < 0.05);
  assert.ok(later.n < 60);
  const shrunk = decayedEvidence(good.slice(0, 1), T0 + DAY, 10 * DAY, { mean: -0.02, n: 5 });
  assert.ok(shrunk.mean < 0); // one lucky trade does not beat the group's record
});

test("adaptive layer switches a context off when its recent evidence turns negative", () => {
  const cfg = { enabled: true, everyHours: 4, windowDays: 60, halfLifeDays: 10, priorTrades: 5, minProbability: 0.55, fullProbability: 0.7 };
  const m = { strategyName: "capitulacion", timeframe: "3m", type: "crypto" };
  const g = "capitulacion 3m crypto";
  const outcomes = [
    ...Array.from({ length: 40 }, (_, i) => ({ group: g, context: "A", time: T0 + i * DAY, value: 0.01 + gauss() * 0.004 })),
    ...Array.from({ length: 40 }, (_, i) => ({ group: g, context: "B", time: T0 + i * DAY, value: (i < 20 ? 0.01 : -0.015) + gauss() * 0.004 })),
  ];
  const s20 = assess(outcomes, T0 + 20 * DAY, cfg);
  assert.equal(scaleFor(s20, m, "B").scale, 1);
  const s40 = assess(outcomes, T0 + 40 * DAY, cfg);
  assert.equal(scaleFor(s40, m, "A").scale, 1);
  assert.equal(scaleFor(s40, m, "B").scale, 0);
  assert.equal(scaleFor(s40, m, "nuevo").arm.context, "*"); // unseen context falls back to the group
  assert.equal(scaleFor(null, m, "A").scale, 1);
  assert.equal(scaleFor(assess([], T0, cfg), m, "A").scale, 1);
});

test("deflated Sharpe: the more combinations tried, the more evidence a winner needs", () => {
  const daily = Array.from({ length: 60 }, () => 0.002 + gauss() * 0.01);
  const one = deflatedSharpe(daily, 1);
  const many = deflatedSharpe(daily, 216);
  assert.ok(one > many, `${one} vs ${many}`);
  assert.ok(deflatedSharpe(Array.from({ length: 60 }, () => -0.002 + gauss() * 0.01), 1) < 0.5);
  assert.deepEqual(dailyResults([{ openedAt: T0 + DAY, pnl: 1 }, { openedAt: T0, pnl: 2 }, { openedAt: T0 + 3600e3, pnl: 3 }]), [5, 1]);
});
