import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { PaperBroker } from "../dist/brokers/paper.js";
import { parseConfig } from "../dist/config.js";
import { Bot } from "../dist/engine.js";
import { backtestHoraria } from "../dist/horaria/backtest.js";
import { Horaria, newHorariaState } from "../dist/horaria/hourly.js";
import { align, examples, fit, probability, rank } from "../dist/horaria/model.js";
import { Store } from "../dist/store.js";
import { referenceMarket } from "../dist/strategy.js";
import { COSTS, HOUR, market } from "./helpers.mjs";

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "horaria-"));
  dirs.push(d);
  return d;
};

const T = Date.UTC(2026, 0, 10, 22); // decisions at 22:00, 23:00, 00:00 and 01:00 UTC
const COINS = ["AA", "BB", "CC"];

/**
 * Hourly candles where an hour's move tends to repeat (90% of the time), then the last hours as given:
 * `script[coin]` lists the moves of the candles starting at T-1h, T, T+1h... (+1 up, -1 down).
 */
function candles(script) {
  let seed = 7;
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const data = new Map();
  for (const name of [...COINS, "BTC"]) {
    const list = [];
    let price = 100;
    let last = 1;
    for (let t = T - 700 * HOUR; t <= T + 3 * HOUR; t += HOUR) {
      const k = (t - (T - HOUR)) / HOUR;
      const given = script[name]?.[k];
      const move = name === "BTC" ? (rand() < 0.5 ? 0.001 : -0.001) : given !== undefined ? given * 0.01 : (rand() < 0.9 ? last : -last) * 0.01;
      if (name !== "BTC") last = Math.sign(move);
      const open = price;
      price *= 1 + move;
      list.push({ time: t, open, high: Math.max(open, price) * 1.001, low: Math.min(open, price) * 0.999, close: price, volume: 1e6 });
    }
    data.set(name, list);
  }
  return data;
}

test("the model learns which coins are more likely to beat the cost next hour and ranks them", () => {
  const data = candles({ AA: [1], BB: [-1], CC: [-1] });
  const upTo = (list) => list.filter((c) => c.time < T);
  const a = align(COINS.map((c) => ({ symbol: `${c}/USDT`, candles: upTo(data.get(c)) })), upTo(data.get("BTC")));
  const i = a.times.length - 1;
  const rows = examples(a, i - 14 * 24, i - 1, 0.003);
  assert.ok(rows.length > 900);
  const m = fit(rows, T);
  // About 45% of the hours beat the cost (90% repeat x half of them up).
  assert.ok(m.baseRate > 0.35 && m.baseRate < 0.55, `${m.baseRate}`);
  const ranking = rank(a, i, m);
  assert.equal(ranking[0].symbol, "AA/USDT"); // the only one that just rose
  assert.ok(ranking[0].p > 0.7 && ranking[0].p - ranking[2].p > 0.3, JSON.stringify(ranking));
  assert.ok(ranking.every((r, k) => !k || ranking[k - 1].p >= r.p));
  assert.ok(probability(m, rows[0].x) > 0 && probability(m, rows[0].x) < 1);
});

function setup(script) {
  const data = candles(script);
  let now = T + 60_000;
  const markets = COINS.map((c) => market(`${c}/USDT`, { paused: "sin ventaja (aprendizaje)" }));
  const { config } = parseConfig({
    crypto: { markets: COINS.map((c) => ({ symbol: `${c}/USDT`, timeframe: "1h" })) },
    dataDir: tempDir(),
    paper: { topUp: { to: 120, id: "2026-10-11" } },
    horaria: { enabled: true, trainDays: 14 },
  });
  // Up to the candle forming now, as Binance answers.
  const source = { name: "fake", history: async (m, since) => data.get(m.base).filter((c) => c.time >= since && c.time <= Math.floor(now / HOUR) * HOUR) };
  const store = new Store(config.dataDir);
  const state = store.load(50);
  const messages = [];
  const logs = [];
  const commands = [];
  const hourly = new Horaria({ config: config.horaria, cost: 0.003, source, reference: referenceMarket("BTC/USDT", markets[0]), state: (state.horaria ??= newHorariaState()), log: (l) => logs.push(l) });
  const bot = new Bot({
    config,
    markets,
    sources: { crypto: source },
    brokers: { crypto: new PaperBroker(state.papers.crypto, { ...COSTS, minOrderUsd: 5 }, "paper-cripto") },
    fx: { rate: async () => 1 },
    store,
    state,
    notify: async (m) => void messages.push(m),
    log: (l) => logs.push(l),
    now: () => now,
    commands: async () => commands.splice(0),
    hourly,
  });
  return { bot, state, messages, logs, commands, hourly, at: (t) => (now = t) };
}

test("every hour challenge 1 buys the most likely coin, even with its markets paused, keeps it while it stays first, and /pausa stops it", async () => {
  // Candles from 21:00 on: AA rises then falls; BB falls, then rises.
  const s = setup({ AA: [1, -1, -1, -1, -1], BB: [-1, 1, 1, 1, 1], CC: [-1, -1, -1, -1, -1] });
  await s.bot.tick();
  // The owner's top-up, once: 50 USD -> 120 USD.
  assert.ok(s.messages.some((m) => /pasa a 120\.00 USD \(se añadieron 70\.00 USD\)/.test(m)), s.messages.join("\n"));
  assert.equal(s.state.papers.crypto.startingBalance, 120);
  assert.equal(s.state.positions.length, 1);
  const a = s.state.positions[0];
  assert.equal(a.kind, "horaria");
  assert.equal(a.symbol, "AA/USDT");
  const usd = a.units * a.entryPrice;
  assert.ok(usd >= 5 && usd < 5.02, `${usd}`);
  assert.ok(!s.messages.some((m) => /abro/.test(m))); // no Telegram message per hourly trade
  assert.ok(s.logs.some((l) => /Operación horaria 2026-01-10 22:00 UTC: compra AA \(probabilidad \d+%; siguientes: /.test(l)), s.logs.join("\n"));
  // Later in the same hour: nothing new.
  s.at(T + 20 * 60_000);
  await s.bot.tick();
  assert.equal(s.state.horaria.decisions.length, 1);
  assert.equal(s.messages.filter((m) => /pasa a 120/.test(m)).length, 1);

  // 23:00: B is now the most likely, so A is sold and B bought; the sale is no Telegram message either.
  s.at(T + HOUR + 60_000);
  await s.bot.tick();
  assert.deepEqual(s.state.positions.map((p) => p.symbol), ["BB/USDT"]);
  assert.equal(s.state.horaria.trades.length, 1);
  assert.match(s.state.horaria.trades[0].reason, /cambia a BB/);
  assert.ok(s.state.horaria.trades[0].pnl < -0.05); // A fell 1% in its hour
  assert.equal(s.state.recentTrades.length, 0); // the strategy's own list stays clean
  assert.ok(Math.abs(s.state.horaria.decisions[0].move + 0.01) < 1e-9);
  assert.equal(s.messages.length, 1);

  // 00:00: B is still first, so it is kept (no fees); a new UTC day, so yesterday's summary goes out.
  s.at(T + 2 * HOUR + 60_000);
  await s.bot.tick();
  assert.equal(s.state.positions.length, 1);
  assert.equal(s.state.positions[0].symbol, "BB/USDT");
  assert.equal(s.state.horaria.trades.length, 1);
  assert.equal(s.state.horaria.decisions.at(-1).action, "mantiene");
  assert.equal(s.state.horaria.model.trainedAt, T + 2 * HOUR + 60_000); // relearned at the first decision of the UTC day
  const daily = s.messages.at(-1);
  assert.match(daily, /operación de cada hora \(2026-01-10\): 2 horas, 2 compras y 0 veces/);
  assert.match(daily, /Operaciones de ese día: 1, 0 con ganancia/);
  assert.match(daily, /superó las comisiones en 1 de 2 horas/); // A fell, B rose 1%
  assert.match(s.hourly.summary(T + 2 * HOUR, "USD"), /se quedó con BB/);

  // 01:00 with /pausa: B is sold and nothing is bought.
  s.commands.push({ name: "pausa", args: [] });
  s.at(T + 3 * HOUR + 60_000);
  await s.bot.tick();
  assert.equal(s.state.positions.length, 0);
  assert.equal(s.state.horaria.decisions.at(-1).action, "pausa");
  assert.equal(s.state.horaria.trades.at(-1).reason, "fin de su hora");
  assert.ok(s.state.horaria.trades.at(-1).pnl > 0); // B rose 1% twice
});

test("the replay follows the same choice: buys the most likely coin each hour and keeps it while it stays first", async () => {
  const data = candles({ AA: [1, -1, -1, -1, -1], BB: [-1, 1, 1, 1, 1], CC: [-1, -1, -1, -1, -1] });
  const src = { name: "fake", history: async (m, since) => data.get(m.base).filter((c) => c.time >= since) };
  const markets = COINS.map((c) => market(`${c}/USDT`));
  const config = { enabled: true, orderUsd: 5, trainDays: 14, retrainHours: 24, waitMinutes: 5 };
  const r = await backtestHoraria(config, { feePct: 0.1, slippagePct: 0.05 }, src, markets, referenceMarket("BTC/USDT", markets[0]), T, T + 3 * HOUR);
  assert.deepEqual(r.hours.map((h) => [h.symbol, h.kept]), [["AA/USDT", false], ["BB/USDT", false], ["BB/USDT", true]]);
  assert.equal(r.trades.length, 2); // A, then B closed at the end of the data
  assert.ok(r.trades[0].pnl < 0 && r.trades[1].pnl > 0);
});
