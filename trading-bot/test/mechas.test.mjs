import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MechasBot, mechasParams } from "../dist/mechas/bot.js";
import { advance, fill, isFilled, leadersAllow, orderPrice, sigma15 } from "../dist/mechas/core.js";
import { assessSide, calibration } from "../dist/mechas/learn.js";
import { eligible, medianRange, selectCoins } from "../dist/mechas/universe.js";
import { loadConfig } from "../dist/config.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 1);
const DEFAULTS = loadConfig(new URL("../config.example.json", import.meta.url).pathname).config.mechas;
const config = (over = {}) => ({ ...DEFAULTS, enabled: true, ...over });
const P = mechasParams(config());
const bar = (time, o, h, l, c) => ({ time, open: o, high: h, low: l, close: c });

test("σ15 scales 1-minute volatility to 15 minutes and needs a full window", () => {
  const closes = [100];
  for (let i = 0; i < 240; i++) closes.push(closes.at(-1) * (i % 2 ? 1.001 : 1 / 1.001));
  assert.ok(Math.abs(sigma15(closes) - Math.log(1.001) * Math.sqrt(15)) < 1e-9);
  assert.ok(Number.isNaN(sigma15(closes.slice(0, 100))));
});

test("orders fill only when price trades past them; the leaders veto each side", () => {
  const o = { side: "long", price: orderPrice("long", 100, 0.04), tick: 0 };
  assert.equal(o.price, 96);
  assert.equal(isFilled(o, bar(0, 100, 100, 96, 99), P), false); // touching is not enough
  assert.equal(isFilled(o, bar(0, 100, 100, 95.9, 99), P), true);
  assert.equal(isFilled({ ...o, tick: 0.005 }, bar(0, 100, 100, 95.9, 99), P), false); // one tick more for coarse coins
  assert.equal(leadersAllow("long", [0.001, -0.001, 0], P), true);
  assert.equal(leadersAllow("long", [0.001, -0.003, 0], P), false);
  assert.equal(leadersAllow("short", [0.003, 0, 0], P), false);
  assert.equal(leadersAllow("long", [NaN, 0, 0], P), false); // no data on a leader: do not trade
});

const order = (over = {}) => ({ symbol: "XUSDT", side: "long", price: 96, distance: 0.04, forTime: T0, notional: 10, virtual: false, tick: 0, predicted: { pWin: 0.65, mean: 0.004 }, ...over });

test("a wick that already recovered by the minute close exits there; otherwise target and stop work from the next minute", () => {
  const quick = fill(order(), bar(T0, 100, 100, 95, 99.9), P);
  assert.equal(quick.closed.reason, "objetivo");
  assert.ok(Math.abs(quick.closed.ret - (99.9 / 96 - 1 - 0.0002 - (99.9 / 96) * 0.0005)) < 1e-9);
  const { position, closed } = fill(order(), bar(T0, 100, 100, 95, 97), P);
  assert.equal(closed, undefined);
  assert.equal(position.takeProfit, 96 * 1.04);
  assert.equal(position.stopLoss, 96 * 0.96);
  // Both touched in one minute: the stop counts (the candle cannot tell which came first).
  assert.equal(advance(position, bar(T0 + MIN, 97, 100, 92, 99), P).reason, "stop");
  // Gap past the target: filled at the open, as taker.
  const gap = advance(position, bar(T0 + MIN, 101, 102, 100.5, 101), P);
  assert.equal(gap.reason, "objetivo");
  assert.equal(gap.exit, 101);
  assert.equal(advance(position, bar(T0 + 29 * MIN, 97, 97.5, 96.5, 97), P), null);
  assert.equal(advance(position, bar(T0 + 30 * MIN, 97, 97.5, 96.5, 97), P).reason, "tiempo");
  // Shorts mirror it.
  const s = fill(order({ side: "short", price: 104 }), bar(T0, 100, 105, 100, 103), P).position;
  assert.equal(advance(s, bar(T0 + MIN, 103, 103, 99.5, 100), P).reason, "objetivo");
});

const outcomes = (side, n, ret, start = T0) => Array.from({ length: n }, (_, i) => ({ side, time: start + i * 3_600_000, ret: typeof ret === "function" ? ret(i) : ret, virtual: false }));
const learnCfg = { halfLifeDays: 14, priorTrades: 10, priorMean: 0.004, priorWinRate: 0.65, minTrades: 20, minProbability: 0.6, fullProbability: 0.85 };

test("each side trades while it wins more than half the time with a positive mean, and pauses when reality contradicts it", () => {
  const now = T0 + 40 * 3_600_000;
  assert.equal(assessSide([], "long", now, learnCfg).scale, 1); // only the backtest prior
  const good = assessSide(outcomes("long", 40, (i) => (i % 3 ? 0.012 : -0.01)), "long", now, learnCfg);
  assert.ok(good.scale > 0 && good.pWin > 0.5 && good.mean > 0);
  const losing = assessSide(outcomes("short", 40, (i) => (i % 3 ? -0.01 : 0.008)), "short", now, learnCfg);
  assert.equal(losing.scale, 0);
  assert.match(losing.why, /gana el|media/);
  // Winning often but losing more when wrong: more than 50% is not enough.
  const trap = assessSide(outcomes("long", 40, (i) => (i % 4 ? 0.003 : -0.02)), "long", now, learnCfg);
  assert.ok(trap.pWin > 0.5);
  assert.equal(trap.scale, 0);
  assert.deepEqual(calibration([{ ret: 0.01, predicted: { pWin: 0.7 } }, { ret: -0.01, predicted: { pWin: 0.5 } }]), { n: 2, predicted: 0.6, realized: 0.5 });
});

test("the coins are the most volatile established perpetuals, without excluded ones", async () => {
  const coins = [
    { symbol: "WILDUSDT", quoteVolume: 50e6, tick: 0.0001, crypto: true },
    { symbol: "CALMUSDT", quoteVolume: 50e6, tick: 0.0001, crypto: true },
    { symbol: "NEWUSDT", quoteVolume: 50e6, tick: 0.0001, crypto: true },
    { symbol: "BTCUSDT", quoteVolume: 9e9, tick: 0, crypto: true },
    { symbol: "TINYUSDT", quoteVolume: 1e6, tick: 0, crypto: true },
    { symbol: "TSLAUSDT", quoteVolume: 80e6, tick: 0, crypto: false },
  ];
  const days = (range, n) => Array.from({ length: n }, (_, i) => ({ time: i, open: 1, high: 1 + range, low: 1, close: 1 }));
  const src = { coins: async () => coins, days: async (s, n) => (s === "WILDUSDT" ? days(0.2, n) : s === "CALMUSDT" ? days(0.05, n) : days(0.5, 10)) };
  const c = config({ coins: 5 });
  assert.deepEqual(eligible(coins, c).map((x) => x.symbol), ["WILDUSDT", "CALMUSDT", "NEWUSDT"]);
  const picks = await selectCoins(src, c);
  assert.deepEqual(picks.map((p) => p.symbol), ["WILDUSDT", "CALMUSDT"]); // NEW is too young
  assert.ok(Math.abs(picks[0].range - 0.2) < 1e-12);
  assert.equal(medianRange([{ high: 1.1, low: 1 }, { high: 1.3, low: 1 }, { high: 1.2, low: 1 }]).toFixed(2), "0.20");
});

/** 300 quiet minutes for a coin and three leaders, then whatever `script` returns for later minutes. */
function market(script = () => null, leaderMove = () => 0) {
  const bars = new Map();
  const quiet = (s, i, base) => { const p = base * (1 + (i % 2 ? 0.002 : 0)); return bar(T0 + i * MIN, p, p * 1.001, p * 0.999, p); };
  return {
    bar(symbol, i) {
      if (symbol === "XUSDT") return script(i) ?? quiet(symbol, i, 100);
      const p = 50 * (1 + leaderMove(i));
      return bar(T0 + i * MIN, p, p, p, p);
    },
    feed(bot, upTo) {
      for (const s of ["XUSDT", ...bot.d?.config?.leaders ?? ["BTCUSDT", "ETHUSDT", "SOLUSDT"]]) {
        const list = bars.get(s) ?? [];
        for (let i = list.length; i <= upTo; i++) list.push(this.bar(s, i));
        bars.set(s, list);
        bot.addBars(s, list.slice(-5));
      }
    },
  };
}

function run(bot, mkt, minutes) {
  for (let i = 0; i <= minutes; i++) {
    mkt.feed(bot, i);
    if (i >= 260) bot.processMinute(T0 + i * MIN, true);
  }
}

const newBot = (over = {}, dir) => new MechasBot({ config: config({ shorts: false, ...over }), source: {}, notify: async () => {}, log: () => {}, dir, now: () => T0 });

test("a wick in a calm market is bought and sold back at the target; the account and the learner record it", () => {
  const bot = newBot();
  bot.setCoins([{ symbol: "XUSDT", range: 0.2, tick: 0 }], T0);
  // Minute 270: the price spikes down 6% and closes back at 99.
  const mkt = market((i) => (i === 270 ? bar(T0 + i * MIN, 100, 100.1, 94, 99.9) : null));
  run(bot, mkt, 280);
  assert.equal(bot.state.closed.length, 1);
  const t = bot.state.closed[0];
  assert.equal(t.side, "long");
  assert.equal(t.reason, "objetivo");
  assert.ok(t.pnl > 0 && bot.state.balance > 50);
  assert.equal(bot.state.outcomes.length, 1);
  assert.match(bot.summary(T0 + 280 * MIN), /Reto 2.*\n.*\nHoy: 1 operaciones, 1 ganadoras/);
});

test("no wick buys while a big coin is falling", () => {
  const bot = newBot();
  bot.setCoins([{ symbol: "XUSDT", range: 0.2, tick: 0 }], T0);
  const mkt = market((i) => (i === 270 ? bar(T0 + i * MIN, 100, 100.1, 94, 99.9) : null), (i) => (i >= 260 ? -0.001 * (i - 260) : 0));
  run(bot, mkt, 280);
  assert.equal(bot.state.closed.length, 0);
  assert.equal(bot.state.outcomes.length, 0);
});

test("a side the learner paused is only observed: the outcome is learned, the balance does not move", () => {
  const bot = newBot();
  bot.setCoins([{ symbol: "XUSDT", range: 0.2, tick: 0 }], T0);
  bot.state.outcomes = outcomes("long", 40, -0.01, T0 - 41 * 3_600_000);
  const mkt = market((i) => (i === 270 ? bar(T0 + i * MIN, 100, 100.1, 94, 99.9) : null));
  run(bot, mkt, 280);
  assert.equal(bot.state.closed.length, 0);
  assert.equal(bot.state.balance, 50);
  assert.equal(bot.state.outcomes.filter((o) => o.virtual).length, 1);
});

test("the state survives a restart, and missed minutes only close positions, never open new ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mechas-"));
  try {
    const bot = newBot({}, dir);
    bot.setCoins([{ symbol: "XUSDT", range: 0.2, tick: 0 }], T0);
    // Minute 270 fills and closes at 97 (between stop and target); minute 275 reaches the target.
    const mkt = market((i) => (i === 270 ? bar(T0 + i * MIN, 100, 100.1, 95, 97) : i > 270 && i < 275 ? bar(T0 + i * MIN, 97, 97.5, 96.5, 97) : i >= 275 ? bar(T0 + i * MIN, 101, 101.5, 100.5, 101) : null));
    run(bot, mkt, 271);
    assert.equal(bot.state.positions.length, 1);
    bot.state.pending = [];
    bot.save();
    // Restart and catch up from a source that serves the missed minutes.
    let now = T0 + 300 * MIN + 5_000;
    const source = { minutes: async (s, since, n) => Array.from({ length: 300 }, (_, i) => mkt.bar(s, i)).filter((b) => b.time >= since && b.time + MIN <= n), coins: async () => [], days: async () => [] };
    const again = new MechasBot({ config: config({ shorts: false }), source, notify: async () => {}, log: () => {}, dir, now: () => now });
    again.state.coinsAt = now; // no re-selection in the test
    await again.tick();
    assert.equal(again.state.closed.length, 1);
    assert.equal(again.state.closed[0].reason, "objetivo");
    // Orders exist only for the next minute: none were placed for the minutes the bot missed.
    assert.ok(again.state.pending.every((o) => o.forTime === T0 + 300 * MIN));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
