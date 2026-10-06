import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backtestTendencia } from "../dist/tendencia/backtest.js";
import { TendenciaBot } from "../dist/tendencia/bot.js";
import { inTrend, rebalance, TrendModel, trendWeights } from "../dist/tendencia/core.js";
import { loadConfig } from "../dist/config.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const DEFAULTS = loadConfig(new URL("../config.example.json", import.meta.url).pathname).config.tendencia;
const config = (over = {}) => ({ ...DEFAULTS, enabled: true, ...over });
const LB = [5, 10, 20];

test("each lookback enters on a close above its channel and leaves under the channel's midpoint", () => {
  const m = new TrendModel(LB);
  for (let i = 0; i < 5; i++) m.add(100);
  assert.deepEqual(m.view(), { on: 0, models: 0 }); // not one lookback has seen 5 earlier closes yet
  m.add(100);
  assert.deepEqual(m.view(), { on: 0, models: 1 }); // a flat close is not a breakout
  for (let i = 0; i < 25; i++) m.add(101 + i);
  assert.deepEqual(m.view(), { on: 3, models: 3 });
  // A sharp drop: under every channel's midpoint, so every model leaves.
  m.add(100);
  assert.deepEqual(m.view(), { on: 0, models: 3 });
  assert.equal(inTrend({ on: 5, models: 9 }, 0.5), true);
  assert.equal(inTrend({ on: 4, models: 9 }, 0.5), false);
});

test("rebalancing fills equal slots, never spends cash it does not have, skips orders under the minimum and books each sale", () => {
  const holdings = {};
  const c = { minOrderUsd: 5, cost: 0.0015 };
  const w = trendWeights({ AUSDT: { on: 9, models: 9 }, BUSDT: { on: 7, models: 9 }, CUSDT: { on: 1, models: 9 } }, ["AUSDT", "BUSDT", "CUSDT", "DUSDT", "EUSDT"], 0.5);
  assert.deepEqual(w, { AUSDT: 0.2, BUSDT: 0.2, CUSDT: 0, DUSDT: 0, EUSDT: 0 });
  let r = rebalance(50, holdings, { AUSDT: 10, BUSDT: 2 }, w, c);
  assert.equal(r.fills.length, 2);
  assert.ok(r.fills.every((f) => f.side === "buy" && f.reason === "entra" && Math.abs(f.notional - 10) < 1e-9));
  assert.ok(Math.abs(r.cash - (50 - 20 * 1.0015)) < 1e-9);
  // A drift under 5 USD is left alone; A doubles and is trimmed back to its slot; B leaves its trend.
  r = rebalance(r.cash, holdings, { AUSDT: 20, BUSDT: 2.2 }, { AUSDT: 0.2, BUSDT: 0 }, c);
  const sell = r.fills.find((f) => f.symbol === "BUSDT");
  assert.equal(sell.reason, "sale");
  assert.ok(Math.abs(sell.pnl - (11 * (1 - 0.0015) - 10 * 1.0015)) < 1e-9);
  assert.equal(holdings.BUSDT.units, 0);
  const trim = r.fills.find((f) => f.symbol === "AUSDT");
  assert.equal(trim.reason, "ajuste");
  assert.equal(trim.side, "sell");
  // Everything in a trend at once: purchases stop at the cash left.
  const all = rebalance(10, {}, { XUSDT: 1, YUSDT: 1 }, { XUSDT: 0.6, YUSDT: 0.6 }, c);
  assert.ok(all.cash >= -1e-9);
  assert.equal(all.fills.length, 1);
});

/** Daily bars: rising for `up` days from T0 - 400 days, then whatever `after` says. */
function market(after = () => null) {
  const bars = new Map();
  for (let i = -400; i < 30; i++) {
    const close = after(i) ?? 100 * 1.003 ** (i + 400);
    bars.set(T0 + i * DAY, { time: T0 + i * DAY, open: close, high: close, low: close, close });
  }
  return {
    fail: false,
    days: async function (symbol, since) {
      if (this.fail) throw new Error("fetch failed");
      return [...bars.values()].filter((b) => b.time >= since).map((b) => ({ ...b, close: symbol.startsWith("ETH") ? b.close / 10 : b.close }));
    },
  };
}

test("the bot acts once per closed day, tells Telegram what it bought, keeps its state and waits when the candles do not load", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tendencia-"));
  try {
    const src = market((i) => (i >= 2 ? 50 : null)); // a crash on day 2
    const sent = [];
    const logs = [];
    let now = T0 + 5 * 60_000;
    const make = () => new TendenciaBot({ config: config({ coins: ["BTC", "ETH"] }), source: src, notify: async (t) => void sent.push(t), log: (l) => logs.push(l), dir, now: () => now });
    let bot = make();
    await bot.tick();
    assert.equal(bot.state.trades.length, 2);
    assert.match(sent[0], /compra BTC: 25\.00 USD/);
    assert.match(sent[0], /tendencia en 9 de 9 plazos/);
    now += 60 * 60_000;
    await bot.tick(); // same day: nothing new
    assert.equal(bot.state.trades.length, 2);
    assert.match(bot.summary(), /BTC: en tendencia \(9 de 9 plazos\), 25\.\d\d USD/);
    // Restart: the state is read back from disk.
    bot = make();
    assert.equal(bot.state.trades.length, 2);
    // Next day Binance does not answer: it waits, says so once, and acts when the candles come back.
    now = T0 + DAY + 10 * 60_000;
    src.fail = true;
    await bot.tick();
    await bot.tick();
    assert.equal(logs.filter((l) => /sin velas diarias de BTC/.test(l)).length, 1);
    assert.equal(bot.state.lastDay, T0 - DAY);
    src.fail = false;
    await bot.tick();
    assert.equal(bot.state.lastDay, T0);
    // Day 3: the crash closed every trend, so it sells everything with a loss.
    now = T0 + 3 * DAY + 10 * 60_000;
    await bot.tick();
    const sales = bot.state.trades.filter((t) => t.reason === "sale");
    assert.equal(sales.length, 2);
    assert.ok(sales.every((t) => t.pnl < 0));
    assert.match(sent.at(-1), /vende BTC: .* pierde .*: salió de la tendencia/);
    assert.ok(bot.state.cash > 40 && bot.state.cash < 50);
    assert.equal(Object.keys(bot.state.holdings).length, 0);
    const report = bot.report();
    assert.equal(report.ultimoCierre, new Date(T0 + 2 * DAY).toISOString().slice(0, 10));
    assert.ok(existsSync(join(dir, "operaciones.csv")));
    assert.equal(readFileSync(join(dir, "operaciones.csv"), "utf8").trim().split("\n").length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the backtest replays the same daily step: decisions at the close, orders at the next open", async () => {
  const src = market((i) => (i >= 10 ? 100 * 1.003 ** 410 * 0.5 : null));
  const r = await backtestTendencia(config({ coins: ["BTC"] }), src, T0, T0 + 20 * DAY);
  assert.equal(r.equity.length, 19);
  assert.equal(r.trades[0].reason, "entra");
  assert.equal(r.trades[0].time, T0 + DAY); // decided at the close of T0, bought at the next open
  const exit = r.trades.find((t) => t.reason === "sale");
  assert.equal(exit.day, T0 + 10 * DAY);
  assert.ok(r.equity.at(-1).value < 50);
  assert.equal(r.btc.length, 19);
});
