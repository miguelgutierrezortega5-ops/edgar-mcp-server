import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { simulate } from "../dist/backtest.js";
import { telegramCommands } from "../dist/notify.js";
import { selectPairs } from "../dist/pairs.js";
import { blocked, newProtectionState, onClose } from "../dist/protections.js";
import { emaCross } from "../dist/strategies/ema.js";
import { Store } from "../dist/store.js";
import { lookaheadCheck } from "../dist/verify.js";
import { bars, COSTS, FAST, HOUR, market, RISK, T0, vShape } from "./helpers.mjs";

const realFetch = globalThis.fetch;
const env = { ...process.env };
const dirs = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...env };
});
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const json = (body) => new Response(JSON.stringify(body), { status: 200 });

test("protections: cooldown per market and a guard after a run of stop-losses", () => {
  const p = { cooldownBars: 20, stopGuardCount: 3, stopGuardMinutes: 60, stopGuardPauseMinutes: 240 };
  const s = newProtectionState();
  assert.equal(onClose(s, p, "A", "take-profit", T0, 60_000), null);
  assert.match(blocked(s, "A", T0 + 19 * 60_000), /enfriamiento/);
  assert.equal(blocked(s, "A", T0 + 20 * 60_000), null);
  assert.equal(blocked(s, "B", T0), null);
  onClose(s, p, "B", "stop-loss", T0, 60_000);
  onClose(s, p, "C", "stop-loss", T0 + 61 * 60_000, 60_000); // first one has left the window
  assert.equal(onClose(s, p, "D", "stop-loss", T0 + 70 * 60_000, 60_000), null);
  assert.match(onClose(s, p, "E", "stop-loss (OANDA)", T0 + 80 * 60_000, 60_000), /3 stop-loss/);
  assert.match(blocked(s, "Z", T0 + 81 * 60_000), /racha/);
  assert.equal(blocked(s, "Z", T0 + 80 * 60_000 + 240 * 60_000), null);
});

test("portfolio simulation: one account, a shared position limit, skipped signals counted", () => {
  const candles = bars(vShape());
  const series = ["BTC/USD", "ETH/USD", "SOL/USD"].map((s) => ({ market: market(s), candles, rateAt: () => 1 }));
  const one = simulate({ series: series.slice(0, 1), risk: RISK, costs: COSTS, startingBalance: 10_000 });
  const shared = simulate({ series, risk: { ...RISK, maxOpenPositions: 1 }, costs: COSTS, startingBalance: 10_000 });
  assert.equal(shared.trades.length, one.trades.length); // identical markets: only one can hold a position
  assert.equal(shared.skipped, 2 * one.trades.length);
  const wide = simulate({ series, risk: RISK, costs: COSTS, startingBalance: 10_000 });
  assert.equal(wide.trades.length, 3 * one.trades.length);
  assert.ok(Math.abs(wide.endEquity - (10_000 + wide.trades.reduce((a, t) => a + t.pnl, 0))) < 1e-6);
  assert.equal(wide.markets.length, 3);
});

test("look-ahead check passes honest strategies and catches one that peeks at the next bar", () => {
  const candles = bars(vShape());
  const honest = lookaheadCheck({ strategy: emaCross, params: FAST, allowShort: true, candles });
  assert.ok(honest.checked > 20);
  assert.equal(honest.mismatches.length, 0);
  const cheat = {
    ...emaCross,
    prepare: (c) => c,
    evaluate: (c, i) => ({ time: 0, close: 0, atr: 1, exitLong: false, exitShort: false, reason: "", info: "", entry: c[i + 1] && c[i + 1].close > c[i].close ? { side: "long", stopDistance: 1, takeProfitDistance: null, maxBars: null } : null }),
  };
  assert.ok(lookaheadCheck({ strategy: cheat, params: FAST, allowShort: false, candles }).mismatches.length > 0);
});

test("pair selection filters by volume band, spread, activity, age and kind of token", async () => {
  const now = T0 + 400 * 86_400_000;
  const sym = (base) => ({ symbol: `${base}USDT`, baseAsset: base, quoteAsset: "USDT", status: "TRADING" });
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("exchangeInfo")) return json({ symbols: ["GOOD", "BIG", "TINY", "WIDE", "QUIET", "NEW", "USDC", "BTCUP", "OK2"].map(sym).concat([{ ...sym("HALT"), status: "BREAK" }]) });
    if (u.pathname.endsWith("24hr"))
      return json(
        [["GOOD", 5e6], ["BIG", 50e6], ["TINY", 1e5], ["WIDE", 3e6], ["QUIET", 3e6, 50], ["NEW", 4e6], ["USDC", 3e6], ["BTCUP", 3e6], ["OK2", 2e6], ["HALT", 3e6]].map(([b, v, count = 50_000]) => ({ symbol: `${b}USDT`, quoteVolume: String(v), count })),
      );
    if (u.pathname.endsWith("bookTicker")) return json(["GOOD", "BIG", "TINY", "WIDE", "QUIET", "NEW", "USDC", "BTCUP", "OK2", "HALT"].map((b) => ({ symbol: `${b}USDT`, bidPrice: "1", askPrice: b === "WIDE" ? "1.01" : "1.001" })));
    if (u.pathname.endsWith("klines")) return json([[u.searchParams.get("symbol") === "NEWUSDT" ? now - 10 * 86_400_000 : T0]]);
    throw new Error(url);
  };
  const picks = await selectPairs({ quote: "USDT", minVolumeUsd: 1e6, maxVolumeUsd: 8e6, maxSpreadPct: 0.2, minAgeDays: 180, minTrades: 10_000, max: 5, exclude: ["OK2"] }, now);
  assert.deepEqual(picks.map((p) => p.symbol), ["GOOD/USDT"]);
  assert.ok(Math.abs(picks[0].spreadPct - 0.09995) < 1e-3);
});

test("Telegram commands: only from the owner's chat, and never the backlog from before the start", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "t";
  process.env.TELEGRAM_CHAT_ID = "42";
  const batches = [
    [{ update_id: 1, message: { chat: { id: 42 }, text: "/cerrar todo" } }],
    [
      { update_id: 2, message: { chat: { id: 42 }, text: "/Cerrar@mi_bot BTC" } },
      { update_id: 3, message: { chat: { id: 7 }, text: "/cerrar todo" } },
      { update_id: 4, message: { chat: { id: 42 }, text: "hola" } },
    ],
  ];
  const offsets = [];
  globalThis.fetch = async (url) => {
    offsets.push(new URL(url).searchParams.get("offset"));
    return json({ result: batches.shift() ?? [] });
  };
  const poll = telegramCommands(true, () => {});
  assert.deepEqual(await poll(), []); // backlog discarded
  assert.deepEqual(await poll(), [{ name: "cerrar", args: ["BTC"] }]);
  assert.deepEqual(offsets, ["0", "2"]);
  assert.equal(telegramCommands(false, () => {}), undefined);
});

test("state files from the shared-paper-account version are migrated", () => {
  const dir = mkdtempSync(join(tmpdir(), "state-"));
  dirs.push(dir);
  const old = { version: 1, paper: { balance: 9_500, startingBalance: 10_000, nextId: 3 }, positions: [{ id: "P1", broker: "paper", type: "forex" }], lastBar: {}, risk: {}, recentTrades: [] };
  writeFileSync(join(dir, "state.json"), JSON.stringify(old));
  const s = new Store(dir).load(10_000);
  assert.equal(s.papers.crypto.balance, 9_500);
  assert.equal(s.papers.forex.balance, 10_000);
  assert.equal(s.positions[0].broker, "paper-forex");
  assert.deepEqual(s.protections, { cooldownUntil: {}, recentStops: [], pausedUntil: 0 });
});
