import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { after, afterEach, test } from "node:test";
import { assess, futuresState, scaleFor } from "../dist/adaptive.js";
import { alignToBars, FuturesSource, openInterestChange, parseMetricsCsv } from "../dist/data/futures.js";
import { firstZipEntry } from "../dist/data/zip.js";
import { features, footprintsAt } from "../dist/research.js";
import { T0 } from "./helpers.mjs";

const realFetch = globalThis.fetch;
const dirs = [];
afterEach(() => (globalThis.fetch = realFetch));
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const M5 = 5 * 60_000;

/** Minimal zip with one deflated file, as Binance's archive ships them. */
function zip(name, text) {
  const data = deflateRawSync(Buffer.from(text));
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(8, 8);
  h.writeUInt32LE(data.length, 18);
  h.writeUInt32LE(text.length, 22);
  h.writeUInt16LE(name.length, 26);
  return Buffer.concat([h, Buffer.from(name), data]);
}
const iso = (t) => new Date(t).toISOString().slice(0, 19).replace("T", " ");
const HEADER = "create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio";
const csvDay = (start, oi = () => 1000) => [HEADER, ...Array.from({ length: 288 }, (_, k) => `${iso(start + k * M5)},ALTUSDT,${oi(k)},${oi(k) * 2},1.5,2.5,1.2,0.9`)].join("\n");

test("zip reader and metrics CSV parser (rows arrive unsorted)", () => {
  const csv = `${HEADER}\n2026-01-05 00:10:00,X,10,20,1,2,3,4\n2026-01-05 00:05:00,X,9,18,1,2,3,4\n`;
  assert.equal(firstZipEntry(zip("x.csv", csv)), csv);
  const pts = parseMetricsCsv(csv);
  assert.deepEqual(pts.map((p) => p.time), [T0 + M5, T0 + 2 * M5]);
  assert.deepEqual(pts[1], { time: T0 + 2 * M5, openInterest: 10, openInterestValue: 20, topAccountsRatio: 1, topPositionsRatio: 2, crowdRatio: 3, takerRatio: 4 });
  assert.throws(() => firstZipEntry(Buffer.from("not a zip")), /zip/);
});

test("alignment never uses a point published after the bar's close", () => {
  const pts = [{ time: T0 }, { time: T0 + M5 }, { time: T0 + 2 * M5 }];
  const bars = [{ time: T0 - 3 * 60_000 }, { time: T0 + 60_000 }, { time: T0 + 3 * 60_000 }, { time: T0 + 60 * 60_000 }];
  const a = alignToBars(bars, pts, 3 * 60_000);
  assert.deepEqual(a.map((p) => p?.time), [T0, T0, T0 + M5, undefined]); // the last one is too old
});

test("open interest change and the futures state of each bar", () => {
  const pts = Array.from({ length: 20 }, (_, k) => ({ time: T0 + k * M5, openInterest: k < 10 ? 1000 : k < 15 ? 1040 : 1000 }));
  const bars = Array.from({ length: 30 }, (_, k) => ({ time: T0 + k * 3 * 60_000 }));
  const oi = openInterestChange(bars, pts, 3 * 60_000);
  assert.ok(Number.isNaN(oi[0]));
  const states = futuresState(bars, pts, 3 * 60_000);
  assert.ok(states.includes("apalancamiento entrando"));
  assert.ok(states.includes("liquidaciones o cierres"));
  assert.equal(futuresState(bars, undefined, 3 * 60_000)[5], "futuros ?");
  const f = features(bars.map((b) => ({ ...b, open: 1, high: 1, low: 1, close: 1, volume: 1 })), undefined, pts);
  const i = states.indexOf("apalancamiento entrando");
  assert.ok(footprintsAt(f, i).includes("apalancamiento entrando"));
});

test("futures source: archive days (cached), then the live API, which may be geo-blocked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fut-"));
  dirs.push(dir);
  const now = T0 + 2 * 86_400_000 + 3_600_000;
  const calls = [];
  const logs = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("metrics-2026-01-05")) return new Response(zip("a.csv", csvDay(T0)));
    if (u.includes("metrics-2026-01-06")) return new Response(zip("b.csv", csvDay(T0 + 86_400_000, (k) => 1000 + k)));
    if (u.includes("fundingRate-2026-01")) return new Response(zip("f.csv", `calc_time,funding_interval_hours,last_funding_rate\n${T0},8,0.0001\n${T0 + 8 * 3600e3},8,-0.0002\n`));
    if (u.includes("fapi.binance.com")) return new Response('{"code":0,"msg":"restricted location"}', { status: 451 });
    return new Response("", { status: 404 });
  };
  const fs = new FuturesSource(dir, (m) => logs.push(m));
  const pts = await fs.metrics("ALTUSDT", T0, now);
  assert.equal(pts.length, 576);
  assert.equal(pts.at(-1).openInterest, 1287);
  assert.match(logs[0], /451/);
  const archiveCalls = calls.filter((c) => c.includes("data.binance.vision")).length;
  await fs.metrics("ALTUSDT", T0, now); // cached days, and the blocked API is not asked again
  assert.equal(calls.filter((c) => c.includes("data.binance.vision")).length, archiveCalls);
  assert.equal(calls.filter((c) => c.includes("fapi")).length, 5);
  const funding = await fs.funding("ALTUSDT", T0, now);
  assert.deepEqual(funding.map((f) => f.rate), [0.0001, -0.0002]);
});

test("futures source: live points fill the hours the archive does not have yet", async () => {
  const now = T0 + 3_600_000;
  const row = (k) => ({ timestamp: T0 + k * M5 });
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.host === "data.binance.vision") return new Response("", { status: 404 });
    const rows = [0, 1, 2].map((k) => {
      if (u.pathname.endsWith("openInterestHist")) return { ...row(k), sumOpenInterest: String(100 + k), sumOpenInterestValue: "1" };
      if (u.pathname.endsWith("takerlongshortRatio")) return { ...row(k), buySellRatio: "1.1" };
      return { ...row(k), longShortRatio: u.pathname.includes("Position") ? "3" : u.pathname.includes("top") ? "2" : "1.5" };
    });
    return new Response(JSON.stringify(rows));
  };
  const pts = await new FuturesSource(undefined).metrics("ALTUSDT", T0, now);
  assert.deepEqual(pts[2], { time: T0 + 2 * M5, openInterest: 102, openInterestValue: 1, topAccountsRatio: 2, topPositionsRatio: 3, crowdRatio: 1.5, takerRatio: 1.1 });
});

test("adaptive sizing by context is opt-in; by default the whole group decides", () => {
  const cfg = { enabled: true, everyHours: 4, windowDays: 60, halfLifeDays: 30, priorTrades: 0, minProbability: 0.55, fullProbability: 0.7, useContexts: false };
  const g = "capitulacion 3m crypto";
  const outcomes = Array.from({ length: 40 }, (_, k) => ({ group: g, context: k % 2 ? "flujo normal, liquidaciones o cierres" : "flujo tóxico, apalancamiento entrando", time: T0 + k * 3600e3, value: k % 2 ? 0.01 : -0.004 }));
  const state = assess(outcomes, T0 + 40 * 3600e3, cfg);
  const m = { strategyName: "capitulacion", timeframe: "3m", type: "crypto" };
  assert.equal(scaleFor(state, m, "flujo tóxico, apalancamiento entrando", false).arm.context, "*");
  assert.equal(scaleFor(state, m, "flujo tóxico, apalancamiento entrando", true).scale, 0);
  assert.equal(scaleFor(state, m, "flujo normal, liquidaciones o cierres", true).scale, 1);
  assert.equal(scaleFor(state, m, "futuros ?", true).arm.context, "*"); // unknown values carry no evidence
});
