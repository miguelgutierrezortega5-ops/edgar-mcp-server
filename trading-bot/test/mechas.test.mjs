import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MechasBot, mechasParams } from "../dist/mechas/bot.js";
import { advance, fill, isFilled, leadersAllow, orderPrice, sigma15 } from "../dist/mechas/core.js";
import { assessSide, calibration } from "../dist/mechas/learn.js";
import { compare, dayOf, emptyShadow, trimShadow, tune } from "../dist/mechas/shadow.js";
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

test("live minutes: coins are fetched at once, an order decided too late is skipped, minutes without orders are counted", async () => {
  const mkt = market();
  let now;
  let inFlight = 0;
  let most = 0;
  const source = {
    minutes: async (s, since, n) => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return Array.from({ length: 400 }, (_, i) => mkt.bar(s, i)).filter((b) => b.time >= since && b.time + MIN <= n);
    },
    coins: async () => [],
    days: async () => [],
  };
  const bot = new MechasBot({ config: config({ shorts: false }), source, notify: async () => {}, log: () => {}, now: () => now });
  bot.setCoins([{ symbol: "XUSDT", range: 0.2, tick: 0 }], T0);
  now = T0 + 300 * MIN + 3_000;
  await bot.tick();
  assert.ok(most > 1, "the coins are requested in parallel");
  assert.equal(bot.state.coverage, undefined); // the first start is not a gap
  assert.ok(bot.state.pending.length > 0 && bot.state.pending.every((o) => o.forTime === T0 + 300 * MIN));
  // The phone sleeps and wakes 20 s into a minute: no orders for it, four minutes without.
  now = T0 + 304 * MIN + 20_000;
  await bot.tick();
  assert.equal(bot.state.pending.length, 0);
  assert.deepEqual(bot.state.coverage["2026-09-01"], { live: 0, missed: 4 });
  now = T0 + 305 * MIN + 3_000;
  await bot.tick();
  assert.ok(bot.state.pending.length > 0);
  assert.deepEqual(bot.state.coverage["2026-09-01"], { live: 1, missed: 4 });
  assert.match(bot.summary(now), /Minutos sin órdenes hoy: 4 de 5/);
  assert.deepEqual(bot.report(now).minutosConOrdenes, bot.state.coverage);
});

test("without connection no minute is processed until its candles arrive, so an exit during the outage is not skipped", async () => {
  // Minute 302 fills a buy; minute 305, while the phone is offline, reaches the target.
  const mkt = market((i) => (i === 302 ? bar(T0 + i * MIN, 100, 100.1, 95, 97) : i > 302 && i < 305 ? bar(T0 + i * MIN, 97, 97.5, 96.5, 97) : i >= 305 ? bar(T0 + i * MIN, 101, 101.5, 100.5, 101) : null));
  let now;
  let offline = false;
  const logs = [];
  const source = {
    minutes: async (s, since, n) => {
      if (offline) throw new Error("fetch failed");
      return Array.from({ length: 400 }, (_, i) => mkt.bar(s, i)).filter((b) => b.time >= since && b.time + MIN <= n);
    },
    coins: async () => [],
    days: async () => [],
  };
  const bot = new MechasBot({ config: config({ shorts: false }), source, notify: async () => {}, log: (l) => logs.push(l), now: () => now });
  bot.setCoins([{ symbol: "XUSDT", range: 0.2, tick: 0 }], T0);
  for (let i = 300; i <= 303; i++) {
    now = T0 + (i + 1) * MIN + 3_000;
    await bot.tick();
  }
  assert.equal(bot.state.positions.length, 1);
  offline = true;
  for (let i = 304; i <= 308; i++) {
    now = T0 + (i + 1) * MIN + 3_000;
    await bot.tick();
  }
  assert.equal(bot.state.lastMinute, T0 + 303 * MIN); // waiting, nothing skipped
  assert.equal(logs.filter((l) => /sin velas de ninguna moneda \(fetch failed\)/.test(l)).length, 1);
  offline = false;
  now = T0 + 310 * MIN + 3_000;
  await bot.tick();
  assert.equal(bot.state.closed.length, 1);
  assert.equal(bot.state.closed[0].reason, "objetivo");
  assert.equal(bot.state.closed[0].closedAt, T0 + 305 * MIN);
  assert.deepEqual(bot.state.coverage["2026-09-01"], { live: 4, missed: 5 });
  assert.ok(logs.some((l) => /velas de nuevo tras 5 min/.test(l)));
});

test("with the default rule a side pauses on evidence of losses, not on mere doubt", () => {
  const c = { ...learnCfg, halfLifeDays: DEFAULTS.halfLifeDays, minProbability: DEFAULTS.minProbability, priorMean: DEFAULTS.priorMeanPct / 100, priorWinRate: DEFAULTS.priorWinRate };
  const now = T0 + 40 * 3_600_000;
  // A flat stretch (wins 2 of 3, mean about zero): doubt, so it keeps trading but smaller.
  const flat = assessSide(outcomes("long", 40, (i) => (i % 3 ? 0.006 : -0.0125)), "long", now, c);
  assert.ok(flat.scale > 0 && flat.scale < 1, flat.why);
  // Clearly losing while still winning more than half: paused.
  const losing = assessSide(outcomes("short", 40, (i) => (i % 3 ? 0.002 : -0.02)), "short", now, c);
  assert.equal(losing.scale, 0);
  assert.match(losing.why, /pausa por debajo de 30%/);
});

test("every variant is followed in the shadow, and the active one matches the real trade exactly", () => {
  const bot = newBot();
  bot.setCoins([{ symbol: "XUSDT", range: 0.2, tick: 0 }], T0);
  // Minute 270: a 3.5% wick, deep enough for orders at 3σ and 4σ but not at 5σ.
  const mkt = market((i) => (i === 270 ? bar(T0 + i * MIN, 100, 100.1, 96.5, 97.5) : i > 270 ? bar(T0 + i * MIN, 99.5, 100.6, 99.4, 100.5) : null));
  run(bot, mkt, 340);
  const day = String(dayOf(T0));
  const daily = bot.state.shadow.daily.long;
  assert.equal(bot.state.closed.length, 1);
  assert.ok(Math.abs(daily["k4 obj1 stop1 30m"][day] - bot.state.closed[0].ret) < 1e-12);
  assert.ok(daily["k3 obj1 stop2 60m"][day] > 0);
  assert.equal(Object.keys(daily).filter((k) => k.startsWith("k5")).length, 0);
  assert.match(bot.summary(T0 + 340 * MIN), /En la sombra: midiendo 12 variantes/);
});

test("the owner hears of each entry, and the first real trade publishes a report once", () => {
  const sent = [];
  let reports = 0;
  const bot = new MechasBot({ config: config({ shorts: false }), source: {}, notify: async (t) => void sent.push(t), log: () => {}, now: () => T0, onFirstTrade: () => reports++ });
  bot.setCoins([{ symbol: "XUSDT", range: 0.2, tick: 0 }], T0);
  // Two wicks that stay open after the fill (close at 97, between stop and target), each recovering later;
  // the second once the first has left the 240-minute volatility window.
  const wick = (i) => (i === 270 || i === 560 ? bar(T0 + i * MIN, 100, 100.1, 95, 97) : (i > 270 && i < 275) || (i > 560 && i < 565) ? bar(T0 + i * MIN, 97, 97.5, 96.5, 97) : null);
  run(bot, market(wick), 600);
  assert.equal(bot.state.closed.length, 2);
  assert.equal(sent.filter((t) => / entra a /.test(t)).length, 2);
  assert.match(sent.find((t) => / entra a /.test(t)), /^🪝 X compra en mecha: entra a 9\d.* con 7\.50 USD, objetivo .*, stop .*, máximo 30 min/);
  assert.equal(reports, 1);
  assert.equal(bot.state.firstTradeAt, T0 + 270 * MIN);
});

/** A shadow with `days` complete days where `better` earned `edge` more per day than the active variant. */
function shadowWith(days, better, edge, today) {
  const s = emptyShadow("k4 obj1 stop1 30m", today - days);
  for (let d = today - days; d < today; d++) {
    const base = 0.01 * Math.sin(d); // the market's daily swing, shared by every variant
    s.daily.long["k4 obj1 stop1 30m"] = { ...s.daily.long["k4 obj1 stop1 30m"], [d]: base };
    s.daily.long[better] = { ...s.daily.long[better], [d]: base + edge + 0.002 * Math.cos(3 * d) };
    s.daily.long["k3 obj1 stop1 30m"] = { ...s.daily.long["k3 obj1 stop1 30m"], [d]: base + 0.03 * Math.sign(Math.sin(5 * d)) }; // lucky some days, not better
  }
  s.checkedDay = today - 1;
  return s;
}

test("a side moves to another variant only after it clearly beat the active one for long enough", () => {
  const today = dayOf(T0);
  const keys = ["k4 obj1 stop1 30m", "k5 obj1 stop2 60m", "k3 obj1 stop1 30m"];
  const c = { autoTune: true, tuneMinDays: 60, tuneHalfLifeDays: 30, tuneZ: 3 };
  assert.equal(tune(shadowWith(59, "k5 obj1 stop2 60m", 0.004, today), "long", keys, today, c), null); // too soon
  assert.equal(tune(shadowWith(60, "k5 obj1 stop2 60m", 0.004, today), "long", keys, today, c).key, "k5 obj1 stop2 60m");
  assert.equal(tune(shadowWith(60, "k5 obj1 stop2 60m", 0.004, today), "long", keys, today, { ...c, autoTune: false }), null);
  assert.equal(tune(shadowWith(90, "k5 obj1 stop2 60m", 0.0003, today), "long", keys, today, c), null); // a small edge drowns in noise
  const rows = compare(shadowWith(60, "k5 obj1 stop2 60m", 0.004, today), "long", keys, today, 30).rows;
  assert.equal(rows.find((r) => r.key === "k3 obj1 stop1 30m").z < 3, true);
  const old = shadowWith(200, "k5 obj1 stop2 60m", 0.004, today);
  trimShadow(old, today);
  assert.equal(old.since, today - 180);
  assert.equal(Object.keys(old.daily.long["k5 obj1 stop2 60m"]).length, 180);
});

test("after a switch the bot tells the owner and the side's orders use the new distance", () => {
  const sent = [];
  const make = (shadow) => {
    const bot = new MechasBot({ config: config({ shorts: false }), source: {}, notify: async (t) => void sent.push(t), log: () => {}, now: () => T0 });
    bot.setCoins([{ symbol: "XUSDT", range: 0.2, tick: 0 }], T0);
    if (shadow) bot.state.shadow = shadow;
    run(bot, market(), 262);
    return bot;
  };
  const before = make().state.pending[0].distance;
  const bot = make(shadowWith(70, "k5 obj1 stop2 60m", 0.004, dayOf(T0)));
  assert.equal(bot.state.shadow.active.long, "k5 obj1 stop2 60m");
  assert.equal(bot.state.shadow.switches.length, 1);
  assert.match(sent.join("\n"), /ajusta sus compras en mecha: orden a 5σ, objetivo 1×, stop 2×, máximo 60 min/);
  assert.ok(Math.abs(bot.state.pending[0].distance / before - 5 / 4) < 1e-9);
});
