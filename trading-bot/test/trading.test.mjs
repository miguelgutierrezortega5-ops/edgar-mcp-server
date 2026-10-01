import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { backtest } from "../dist/backtest.js";
import { PaperAccount, PaperBroker } from "../dist/brokers/paper.js";
import { parseConfig } from "../dist/config.js";
import { Bot } from "../dist/engine.js";
import { Store } from "../dist/store.js";
import { computeIndicators, evaluate } from "../dist/strategy.js";
import { bars, COSTS, HOUR, market, RISK, T0, vShape } from "./helpers.mjs";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "bot-test-"));
  dirs.push(d);
  return d;
};

test("paper account: crypto long with fees and slippage", () => {
  const book = { balance: 10_000, nextId: 1 };
  const acct = new PaperAccount(book, COSTS);
  const m = market("BTC/USD");
  const p = acct.open({ market: m, side: "long", units: 0.1, price: 50_000, rate: 1, stopDistance: 1000, takeProfitDistance: 2000, time: T0 });
  close(p.entryPrice, 50_025);
  close(p.entryFee, 5.0025);
  close(p.stop, 49_025);
  close(p.takeProfit, 52_025);
  close(book.balance, 10_000 - 5.0025);
  const t = acct.close(p, { market: m, reason: "take-profit", price: 52_025, rate: 1, time: T0 + HOUR });
  const exit = 52_025 * 0.9995;
  const gross = (exit - 50_025) * 0.1;
  const exitFee = exit * 0.1 * 0.001;
  close(t.exitPrice, exit);
  close(t.pnl, gross - exitFee - 5.0025);
  close(t.fees, exitFee + 5.0025);
  close(book.balance, 10_000 + t.pnl);
});

test("paper account: forex short pays the spread and converts JPY to the account currency", () => {
  const book = { balance: 10_000, nextId: 1 };
  const acct = new PaperAccount(book, COSTS);
  const m = market("USD/JPY");
  const p = acct.open({ market: m, side: "short", units: 10_000, price: 150, rate: 1 / 150, stopDistance: 0.5, takeProfitDistance: null, time: T0 });
  close(p.entryPrice, 149.995); // half of a 1-pip (0.01) spread
  close(p.stop, 150.495);
  assert.equal(p.takeProfit, null);
  assert.equal(p.entryFee, 0);
  close(acct.equity([p], new Map([[m.id, { price: 149, rate: 1 / 149 }]])), 10_000 + (149.995 - 149) * 10_000 / 149);
  const t = acct.close(p, { market: m, reason: "x", price: 149, rate: 1 / 149, time: T0 + HOUR });
  close(t.pnl, ((149.995 - 149.005) * 10_000) / 149);
});

test("backtest: trades only after the warm-up and its equity adds up", () => {
  let seed = 7;
  const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const closes = [100];
  for (let i = 1; i < 800; i++) closes.push(closes[i - 1] * (1 + (random() - 0.48) * 0.02));
  const candles = bars(closes, T0, 0.003);
  const tradeFrom = candles[200].time;
  const r = backtest({ market: market("EUR/USD"), candles, risk: RISK, costs: COSTS, startingBalance: 10_000, rateAt: () => 1, tradeFrom });
  assert.ok(r.trades.length > 3, `only ${r.trades.length} trades`);
  assert.ok(r.trades.some((t) => t.side === "short") && r.trades.some((t) => t.side === "long"));
  const longOnly = backtest({ market: market("BTC/USD"), candles, risk: RISK, costs: COSTS, startingBalance: 10_000, rateAt: () => 1, tradeFrom });
  assert.ok(longOnly.trades.length > 3 && longOnly.trades.every((t) => t.side === "long"));
  assert.ok(r.trades.every((t) => t.openedAt >= tradeFrom && t.closedAt >= t.openedAt));
  close(r.endEquity, 10_000 + r.trades.reduce((s, t) => s + t.pnl, 0));
  assert.ok(r.maxDrawdownPct >= 0 && r.maxDrawdownPct < 100);
  assert.ok(r.exposurePct > 0 && r.exposurePct <= 100);
  assert.equal(r.from, tradeFrom);
  // Never more than one position at a time.
  for (let i = 1; i < r.trades.length; i++) assert.ok(r.trades[i].openedAt >= r.trades[i - 1].closedAt - HOUR);
});

class FakeSource {
  name = "fake";
  data = new Map();
  async history(m, since) {
    return this.data.get(m.id).filter((c) => c.time >= since);
  }
}

function setup(overrides = {}) {
  const { config } = parseConfig({ crypto: { exchange: "kraken", markets: [{ symbol: "BTC/USD", timeframe: "1h" }] }, dataDir: tempDir(), ...overrides });
  const m = market("BTC/USD");
  const store = new Store(config.dataDir);
  const state = store.load(10_000);
  const source = new FakeSource();
  const messages = [];
  const logs = [];
  let now = 0;
  const bot = new Bot({
    config,
    markets: [m],
    sources: { crypto: source },
    brokers: { crypto: new PaperBroker(state.paper, COSTS) },
    fx: { rate: async () => assert.fail("no FX needed for USD markets") },
    store,
    state,
    notify: async (msg) => void messages.push(msg),
    log: (msg) => void logs.push(msg),
    now: () => now,
  });
  return { bot, m, state, store, source, messages, logs, setNow: (t) => (now = t) };
}

/** Bars up to the first bullish signal, plus a forming bar. */
function upToSignal(m) {
  const all = bars(vShape());
  const ind = computeIndicators(all, m.strategy);
  const e = all.findIndex((_, i) => evaluate(ind, i, m.strategy, false).entry);
  assert.ok(e > 0);
  const last = all[e];
  return { candles: [...all.slice(0, e + 1), { ...last, time: last.time + HOUR, open: last.close, high: last.close, low: last.close }], signalBar: last };
}

test("engine: opens on a fresh signal once, then exits at the stop", async () => {
  const s = setup();
  const { candles, signalBar } = upToSignal(s.m);
  s.source.data.set(s.m.id, candles);
  s.setNow(signalBar.time + HOUR + 5 * 60_000);

  await s.bot.tick();
  assert.equal(s.state.positions.length, 1);
  const p = s.state.positions[0];
  assert.equal(p.side, "long");
  assert.ok(p.stop < p.entryPrice);
  assert.equal(s.state.lastBar[s.m.id], signalBar.time);
  // Sized by the tighter of 1% risk at the stop and the 25% notional cap.
  const riskAmount = (p.entryPrice - p.stop) * p.units;
  const notional = p.units * signalBar.close;
  assert.ok(riskAmount <= 100 + 1e-6 && notional <= 2_500 + 1e-6);
  assert.ok(riskAmount > 99.9 || notional > 2_499.9);
  assert.match(s.messages[0], /abro larga en BTC\/USD/);

  await s.bot.tick(); // same bar: nothing new
  assert.equal(s.state.positions.length, 1);
  assert.equal(s.messages.length, 1);

  // The entry bar closes flat; in the next one price dips through the stop and recovers.
  const flat = (time) => ({ time, open: signalBar.close, high: signalBar.close, low: signalBar.close, close: signalBar.close, volume: 1 });
  const crash = { ...flat(signalBar.time + 2 * HOUR), low: p.stop * 0.99 };
  s.source.data.set(s.m.id, [...candles.slice(0, -1), flat(signalBar.time + HOUR), crash, flat(signalBar.time + 3 * HOUR)]);
  s.setNow(signalBar.time + 3 * HOUR + 60_000);
  await s.bot.tick();
  assert.equal(s.state.positions.length, 0);
  const [t] = s.state.recentTrades;
  assert.equal(t.reason, "stop-loss");
  close(t.exitPrice, p.stop * 0.9995); // the stop level less slippage
  assert.ok(t.pnl < 0);
  close(s.state.paper.balance, 10_000 + t.pnl);
  const csv = readFileSync(s.store.tradesPath, "utf8").trim().split("\n");
  assert.equal(csv.length, 2);
  assert.match(csv[1], /BTC\/USD,long/);
  // State survives a restart.
  assert.equal(s.store.load(10_000).recentTrades.length, 1);
});

test("engine: the drawdown breaker closes positions and blocks new ones", async () => {
  const s = setup();
  const { candles, signalBar } = upToSignal(s.m);
  s.source.data.set(s.m.id, candles);
  s.setNow(signalBar.time + HOUR + 60_000);
  s.state.risk.paper = { peakEquity: 20_000, day: new Date(signalBar.time).toISOString().slice(0, 10), dayStartEquity: 10_000, halted: null };
  s.state.positions.push({
    id: "P99", broker: "paper", marketId: s.m.id, symbol: "BTC/USD", type: "crypto", side: "long", units: 0.01,
    entryPrice: signalBar.close, stop: signalBar.close * 0.5, takeProfit: null, openedAt: signalBar.time + HOUR, entryFee: 0, extreme: signalBar.close,
  });
  await s.bot.tick();
  assert.match(s.state.risk.paper.halted, /drawdown/);
  assert.equal(s.state.positions.length, 0);
  assert.equal(s.state.recentTrades[0].reason, "parada por drawdown máximo");
  assert.ok(s.messages.some((m) => m.startsWith("⛔")));
  assert.ok(s.logs.some((l) => /ignorada: bot detenido/.test(l)));
});

test("engine: a failing data source is reported without stopping the bot", async () => {
  const s = setup();
  s.source.history = async () => {
    throw new Error("exchange caído");
  };
  s.setNow(T0);
  for (let i = 0; i < 5; i++) await s.bot.tick();
  assert.ok(s.logs.some((l) => l.includes("exchange caído")));
  assert.equal(s.messages.length, 1);
  assert.match(s.messages[0], /5 veces seguidas/);
});
