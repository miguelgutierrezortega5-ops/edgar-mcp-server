import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ExchangeBroker } from "../dist/brokers/exchange.js";
import { OandaBroker } from "../dist/brokers/oanda.js";
import { parseConfig, REAL_MONEY_ENV, realMoneyBrokers } from "../dist/config.js";
import { OandaClient, OandaSource } from "../dist/data/oanda.js";
import { quoteRate } from "../dist/data/source.js";
import { parseChart } from "../dist/data/yahoo.js";
import { buildBrokers } from "../dist/setup.js";
import { HOUR, market, T0 } from "./helpers.mjs";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env[REAL_MONEY_ENV];
});

/** Replace fetch with a router of (method, path) → JSON body; records every call. */
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, query: u.search, body, headers: init.headers });
    const handler = routes[`${method} ${u.pathname}`];
    if (!handler) return new Response(JSON.stringify({ errorMessage: "not found" }), { status: 404 });
    const res = typeof handler === "function" ? handler(body, u) : handler;
    return new Response(JSON.stringify(res), { status: 200 });
  };
  return calls;
}

const acct = "/v3/accounts/001-001-1-001";
const client = () => new OandaClient("token", "001-001-1-001", "practice");

test("OANDA: orders carry signed units, stop distance and take-profit price", async () => {
  const calls = mockFetch({
    [`GET ${acct}/instruments`]: { instruments: [{ name: "EUR_USD", displayPrecision: 5, tradeUnitsPrecision: 0, minimumTradeSize: "1" }] },
    [`POST ${acct}/orders`]: { orderFillTransaction: { price: "1.10010", commission: "0", tradeOpened: { tradeID: "42", units: "-25000", price: "1.10010" } } },
    [`PUT ${acct}/trades/42/close`]: { orderFillTransaction: { price: "1.09500", pl: "127.5000", financing: "-1.2000", commission: "0", time: "1767600000.000000000" } },
    [`PUT ${acct}/trades/42/orders`]: {},
  });
  const broker = new OandaBroker(client());
  const m = market("EUR/USD");
  await broker.init([m]);
  assert.equal(broker.realMoney, false);
  assert.equal(broker.normalizeUnits(m, 25_000.9), 25_000);
  assert.equal(broker.normalizeUnits(m, 0.4), 0);

  const p = await broker.open({ market: m, side: "short", units: 25_000, price: 1.1, rate: 1, stopDistance: 0.002, takeProfitDistance: 0.004, time: T0 });
  const order = calls.find((c) => c.method === "POST").body.order;
  assert.equal(order.units, "-25000");
  assert.equal(order.type, "MARKET");
  assert.equal(order.stopLossOnFill.distance, "0.00200");
  assert.equal(order.takeProfitOnFill.price, "1.09600");
  assert.equal(calls[0].headers.Authorization, "Bearer token");
  assert.equal(p.brokerRef, "42");
  assert.equal(p.units, 25_000);
  assert.equal(p.entryPrice, 1.1001);
  assert.ok(Math.abs(p.stop - 1.1021) < 1e-9);

  await broker.updateStop(p, 1.099876);
  assert.deepEqual(calls.at(-1).body, { stopLoss: { price: "1.09988", timeInForce: "GTC" } });
  assert.equal(p.stop, 1.09988);

  const t = await broker.close(p, { market: m, reason: "cruce", price: 1.095, rate: 1, time: T0 + HOUR });
  assert.equal(t.exitPrice, 1.095);
  assert.ok(Math.abs(t.pnl - 126.3) < 1e-9);
  assert.equal(t.closedAt, 1767600000000);
});

test("OANDA: reconcile reports trades its stop-loss closed", async () => {
  mockFetch({
    [`GET ${acct}/openTrades`]: { trades: [{ id: "7" }] },
    [`GET ${acct}/trades/8`]: { trade: { id: "8", state: "CLOSED", averageClosePrice: "1.25", realizedPL: "-98.5", financing: "-0.5", closeTime: "1767600000", stopLossOrder: { state: "FILLED" } } },
  });
  const broker = new OandaBroker(client());
  const base = { broker: "oanda", symbol: "GBP/USD", type: "forex", side: "long", units: 1000, entryPrice: 1.26, stop: 1.25, takeProfit: null, openedAt: T0, entryFee: 0, extreme: 1.26 };
  const closed = await broker.reconcile([
    { ...base, id: "O7", marketId: "GBP/USD 1h", brokerRef: "7" },
    { ...base, id: "O8", marketId: "GBP/USD 1h", brokerRef: "8" },
    { ...base, id: "P1", broker: "paper", marketId: "GBP/USD 1h" },
  ]);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].id, "O8");
  assert.equal(closed[0].reason, "stop-loss (OANDA)");
  assert.equal(closed[0].pnl, -99);
});

test("OANDA candles page through history", async () => {
  const calls = mockFetch({
    "GET /v3/instruments/EUR_USD/candles": {
      candles: [
        { time: String(T0 / 1000), volume: 10, complete: true, mid: { o: "1.1", h: "1.2", l: "1.0", c: "1.15" } },
        { time: String((T0 + HOUR) / 1000), volume: 5, complete: false, mid: { o: "1.15", h: "1.16", l: "1.14", c: "1.155" } },
      ],
    },
  });
  const candles = await new OandaSource(client()).history(market("EUR/USD"), T0);
  assert.equal(candles.length, 2);
  assert.deepEqual(candles[0], { time: T0, open: 1.1, high: 1.2, low: 1, close: 1.15, volume: 10 });
  assert.match(calls[0].query, /granularity=H1/);
  assert.match(calls[0].query, /price=M/);
});

/** Minimal stand-in for a ccxt exchange. */
function fakeExchange({ fee } = {}) {
  const balances = { free: { USDT: 1000, BTC: 0 }, total: { USDT: 1000, BTC: 0 } };
  const orders = [];
  return {
    id: "binance",
    has: { fetchBalance: true, createOrder: true, fetchOrder: true },
    options: {},
    markets: { "BTC/USDT": { limits: { amount: { min: 0.0001 }, cost: { min: 5 } } } },
    orders,
    balances,
    async loadMarkets() {},
    amountToPrecision: (_s, a) => (Math.floor(a * 1e5 + 1e-6) / 1e5).toFixed(5),
    async fetchBalance() {
      return structuredClone(balances);
    },
    async createOrder(symbol, type, side, amount) {
      const price = side === "buy" ? 50_000 : 52_000;
      orders.push({ symbol, type, side, amount });
      if (side === "buy") {
        balances.free.USDT -= amount * price;
        balances.free.BTC += amount - (fee ?? 0);
      }
      return { id: String(orders.length), status: "open", filled: undefined };
    },
    async fetchOrder(id) {
      const o = orders[Number(id) - 1];
      const price = o.side === "buy" ? 50_000 : 52_000;
      return { id, status: "closed", filled: o.amount, average: price, fee: o.side === "buy" && fee ? { cost: fee, currency: "BTC" } : { cost: o.amount * price * 0.001, currency: "USDT" } };
    },
  };
}

test("exchange broker: buys within the free balance and sells what it bought", async () => {
  const ex = fakeExchange({ fee: 0.00001 });
  const broker = new ExchangeBroker(ex, false);
  assert.equal(broker.name, "binance-testnet");
  const m = market("BTC/USDT");
  await broker.init([m]);
  assert.equal(broker.normalizeUnits(m, 0.00005, 50_000), 0); // below the minimum amount
  assert.equal(broker.normalizeUnits(m, 0.123456, 50_000), 0.12345);

  // Wants 0.05 BTC (2,500 USDT) but only 1,000 USDT are free.
  const p = await broker.open({ market: m, side: "long", units: 0.05, price: 50_000, rate: 1, stopDistance: 1000, takeProfitDistance: null, time: T0 });
  assert.equal(ex.orders[0].amount, 0.0198);
  assert.ok(Math.abs(p.units - 0.01979) < 1e-12); // fee taken in BTC
  assert.equal(p.entryPrice, 50_000);
  assert.equal(p.stop, 49_000);
  assert.ok(Math.abs(p.entryFee - 0.5) < 1e-9);

  const t = await broker.close(p, { market: m, reason: "x", price: 52_000, rate: 1, time: T0 + HOUR });
  assert.equal(ex.orders[1].side, "sell");
  assert.equal(ex.orders[1].amount, 0.01979);
  assert.ok(Math.abs(t.pnl - (2000 * 0.01979 - 0.01979 * 52_000 * 0.001 - 0.5)) < 1e-9);
  await assert.rejects(broker.open({ market: m, side: "short", units: 1, price: 1, rate: 1, stopDistance: 1, takeProfitDistance: null, time: T0 }), /solo admite compras/);
});

test("config: defaults, validation and the real-money gate", () => {
  const { config, markets } = parseConfig({ crypto: { markets: [{ symbol: "BTC/USDT" }] }, forex: { broker: "oanda", markets: [{ symbol: "EUR/USD", timeframe: "4h", params: { stopAtr: 3 } }] } });
  assert.equal(config.risk.riskPerTradePct, 1);
  assert.equal(config.forex.data, "oanda");
  assert.equal(markets[0].allowShort, false);
  assert.equal(markets[1].allowShort, true);
  assert.equal(markets[1].strategy.stopAtr, 3);
  assert.equal(markets[1].strategy.fastEma, 20);
  assert.deepEqual(realMoneyBrokers(config, markets), []);

  assert.throws(() => parseConfig({ forex: { markets: [{ symbol: "EURUSD" }] } }), /forex\.markets\.0\.symbol/);
  assert.throws(() => parseConfig({ crypto: { markets: [{ symbol: "BTC/USDT", params: { fastEma: 60 } }] } }), /fastEma/);
  assert.throws(() => parseConfig({ crypto: { broker: "exchange", markets: [{ symbol: "BTC/USDT", allowShort: true }] } }), /cortos/);
  assert.throws(() => parseConfig({}), /No hay mercados/);
  assert.throws(() => parseConfig({ crypto: { markets: [{ symbol: "BTC/USDT" }] }, risk: { riskPerTradePct: 50 } }), /riskPerTradePct/);

  const live = parseConfig({ crypto: { broker: "exchange", sandbox: false, markets: [{ symbol: "BTC/USDT" }] } });
  assert.deepEqual(realMoneyBrokers(live.config, live.markets), ["binance"]);
  const state = { paper: { balance: 1, nextId: 1 } };
  assert.throws(() => buildBrokers(live.config, live.markets, state), /DINERO REAL/);
});

test("quoteRate converts the quote currency into the account currency", async () => {
  const fx = { rate: async (from, to) => (from === "GBP" && to === "USD" ? 1.3 : NaN) };
  assert.equal(await quoteRate(market("BTC/USDT"), 50_000, "USD", fx), 1);
  assert.equal(await quoteRate(market("USD/JPY"), 150, "USD", fx), 1 / 150);
  assert.equal(await quoteRate(market("EUR/GBP"), 0.85, "USD", fx), 1.3);
});

test("Yahoo charts: snapshot points fold into the forming bar; daily bars land on their trading date", () => {
  const t = T0 / 1000;
  const hourly = parseChart(
    {
      meta: {},
      timestamp: [t, t + 3600, t + 3600 + 1500],
      indicators: { quote: [{ open: [1, 2, 3], high: [1.5, 2.5, 3], low: [0.5, 1.5, 3], close: [1.2, 2.2, 3] }] },
    },
    "1h",
  );
  assert.equal(hourly.length, 2);
  assert.deepEqual(hourly[1], { time: T0 + HOUR, open: 2, high: 3, low: 1.5, close: 3, volume: 0 });
  const gaps = parseChart({ meta: {}, timestamp: [t], indicators: { quote: [{ open: [null], high: [1], low: [1], close: [1] }] } }, "1h");
  assert.equal(gaps.length, 0);

  const daily = parseChart(
    {
      meta: {},
      timestamp: [t - 3600, t + 23 * 3600, t + 30 * 3600],
      indicators: { quote: [{ open: [1, 2, 2.1], high: [1, 2, 2.1], low: [1, 2, 2.1], close: [1, 2, 2.1] }] },
    },
    "1d",
  );
  assert.deepEqual(daily.map((c) => c.time), [T0, T0 + 24 * HOUR]);
  assert.equal(daily[1].close, 2.1);
});
