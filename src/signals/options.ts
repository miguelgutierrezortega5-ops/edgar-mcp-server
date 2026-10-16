/**
 * Options-implied expectations from Cboe's free delayed option chains (15-minute delay):
 * expected move per expiry (ATM straddle), implied volatility, 25-delta skew, put/call ratios,
 * risk-neutral probabilities of reaching price levels, and the move priced for a dated event
 * such as earnings.
 */
import { httpGet } from "../services/http.js";
import { normCdf } from "./stats.js";

interface CboeOption {
  option: string;
  bid: number;
  ask: number;
  iv: number;
  open_interest: number;
  volume: number;
  delta: number;
  theo: number;
  last_trade_price: number;
}

export interface CboeChain {
  timestamp: string;
  data: { symbol: string; current_price: number; close?: number; prev_day_close?: number; iv30?: number; iv30_change?: number; options: CboeOption[] };
}

export interface Contract {
  expiry: string;
  type: "C" | "P";
  strike: number;
  mid: number | null;
  iv: number;
  delta: number;
  oi: number;
  volume: number;
}

const INDEXES = new Set(["SPX", "NDX", "RUT", "VIX", "XSP", "DJX", "OEX", "MRUT"]);

/** Cboe symbol: indexes take a leading underscore (_SPX); '^SPX' and 'SPX' both work. */
export function cboeSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase().replace(/^[\^_]/, "");
  return INDEXES.has(s) ? `_${s}` : s;
}

export async function getChain(symbol: string): Promise<CboeChain> {
  const chain = await httpGet<CboeChain>("cboe", `/api/global/delayed_quotes/options/${encodeURIComponent(cboeSymbol(symbol))}.json`, { ttl: 5 * 60 * 1000 });
  if (!chain?.data?.options?.length) throw new Error(`Cboe has no listed options for '${symbol}'. Use the US ticker (ASML, TSM) or an index (SPX, NDX, VIX).`);
  return chain;
}

const OCC = /(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

export function parseContracts(options: CboeOption[]): Contract[] {
  const out: Contract[] = [];
  for (const o of options) {
    const m = OCC.exec(o.option);
    if (!m) continue;
    const mid = o.bid > 0 && o.ask > 0 ? (o.bid + o.ask) / 2 : o.theo > 0 ? o.theo : o.last_trade_price > 0 ? o.last_trade_price : null;
    out.push({ expiry: `20${m[1]}-${m[2]}-${m[3]}`, type: m[4] as "C" | "P", strike: Number(m[5]) / 1000, mid, iv: o.iv, delta: o.delta, oi: o.open_interest, volume: o.volume });
  }
  return out;
}

/** Years from `now` to the 16:00 New York close of `expiry` (20:30 UTC splits the DST difference). */
export function yearsTo(expiry: string, now: Date): number {
  return Math.max((Date.parse(`${expiry}T20:30:00Z`) - now.getTime()) / (365 * 86_400_000), 1 / (365 * 24));
}

/** Linear interpolation of implied volatility at strike k from contracts with a usable IV. */
export function ivAt(contracts: Contract[], k: number): number | null {
  const pts = contracts.filter((c) => c.iv > 0.01).sort((a, b) => a.strike - b.strike);
  if (!pts.length) return null;
  if (k <= pts[0].strike) return pts[0].iv;
  if (k >= pts.at(-1)!.strike) return pts.at(-1)!.iv;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].strike >= k) {
      const a = pts[i - 1];
      const b = pts[i];
      return a.iv + ((b.iv - a.iv) * (k - a.strike)) / (b.strike - a.strike);
    }
  }
  return null;
}

/** Risk-neutral P(S_T < K) under Black-Scholes with the smile's IV at K. */
export function probBelow(spot: number, strike: number, sigma: number, years: number, rate: number): number {
  const d2 = (Math.log(spot / strike) + (rate - (sigma * sigma) / 2) * years) / (sigma * Math.sqrt(years));
  return normCdf(-d2);
}

export interface LevelProb {
  /** Relative move, e.g. -0.05. */
  move: number;
  price: number;
  /** P(close at expiry ≤ price) for falls, P(≥ price) for rises. */
  probability: number | null;
}

export interface ExpirySummary {
  expiry: string;
  days: number;
  atmStrike: number;
  straddle: number | null;
  /** Straddle / spot: the move the market prices to expiry (≈ 1.25× the mean absolute move). */
  movePct: number | null;
  atmIv: number | null;
  /** One standard deviation implied by the ATM IV: iv·√T. */
  sigmaMovePct: number | null;
  /** IV of the ~25-delta put minus the ~25-delta call, in vol points (fear of downside). */
  skew25: number | null;
  putCallOi: number | null;
  levels: LevelProb[];
}

export interface ChainSummary {
  symbol: string;
  spot: number;
  asOf: string;
  iv30: number | null;
  putCallVolume: number | null;
  putCallOi: number | null;
  expiries: ExpirySummary[];
  event?: EventMove;
}

export interface EventMove {
  date: string;
  timing: "before_open" | "after_close";
  preExpiry: string | null;
  postExpiry: string;
  /** Straddle of the first expiry that includes the event (includes ordinary volatility). */
  postStraddlePct: number | null;
  /** 1σ move attributable to the event alone: √(σ²_post·T_post − σ²_pre·T_post). */
  eventSigmaPct: number | null;
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

function nearest<T>(items: T[], key: (t: T) => number, target: number): T | undefined {
  let best: T | undefined;
  for (const it of items) if (best === undefined || Math.abs(key(it) - target) < Math.abs(key(best) - target)) best = it;
  return best;
}

function summarizeExpiry(cs: Contract[], expiry: string, spot: number, now: Date, rate: number, levels: number[]): ExpirySummary | null {
  const calls = cs.filter((c) => c.type === "C");
  const puts = cs.filter((c) => c.type === "P");
  const strikes = [...new Set(calls.map((c) => c.strike))].filter((k) => puts.some((p) => p.strike === k));
  const atmStrike = nearest(strikes, (k) => k, spot);
  if (atmStrike === undefined) return null;
  const call = calls.find((c) => c.strike === atmStrike)!;
  const put = puts.find((p) => p.strike === atmStrike)!;
  const straddle = call.mid !== null && put.mid !== null ? call.mid + put.mid : null;
  const T = yearsTo(expiry, now);
  const ivs = [call.iv, put.iv].filter((v) => v > 0.01);
  const atmIv = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
  const p25 = nearest(puts.filter((p) => p.iv > 0.01 && p.delta < 0), (p) => p.delta, -0.25);
  const c25 = nearest(calls.filter((c) => c.iv > 0.01 && c.delta > 0), (c) => c.delta, 0.25);
  const otmPuts = puts.filter((p) => p.strike <= spot);
  const otmCalls = calls.filter((c) => c.strike >= spot);
  return {
    expiry,
    days: Math.round(T * 365 * 10) / 10,
    atmStrike,
    straddle,
    movePct: straddle !== null ? straddle / spot : null,
    atmIv,
    sigmaMovePct: atmIv !== null ? atmIv * Math.sqrt(T) : null,
    skew25: p25 && c25 && Math.abs(p25.delta + 0.25) < 0.1 && Math.abs(c25.delta - 0.25) < 0.1 ? p25.iv - c25.iv : null,
    putCallOi: ratio(puts.reduce((a, p) => a + p.oi, 0), calls.reduce((a, c) => a + c.oi, 0)),
    levels: levels.map((move) => {
      const price = spot * (1 + move);
      const sigma = ivAt(move < 0 ? otmPuts : otmCalls, price) ?? atmIv;
      if (!sigma) return { move, price, probability: null };
      const below = probBelow(spot, price, sigma, T, rate);
      return { move, price, probability: move < 0 ? below : 1 - below };
    }),
  };
}

/** Does an expiry's settlement include an event on `date` (before the open or after the close)? */
export const includesEvent = (expiry: string, date: string, timing: "before_open" | "after_close") =>
  expiry > date || (expiry === date && timing === "before_open");

export function summarizeChain(
  chain: CboeChain,
  opts: { now: Date; rate: number; levels: number[]; maxExpiries: number; minDays?: number; event?: { date: string; timing: "before_open" | "after_close" } },
): ChainSummary {
  const all = parseContracts(chain.data.options);
  const spot = chain.data.current_price || chain.data.close || chain.data.prev_day_close || 0;
  if (!spot) throw new Error(`Cboe returned no underlying price for ${chain.data.symbol}.`);
  const byExpiry = new Map<string, Contract[]>();
  for (const c of all) byExpiry.set(c.expiry, [...(byExpiry.get(c.expiry) ?? []), c]);
  const today = opts.now.toISOString().slice(0, 10);
  const expiries = [...byExpiry.keys()].filter((e) => e >= today).sort();
  const minDays = opts.minDays ?? 0;
  const chosen = expiries.filter((e) => yearsTo(e, opts.now) * 365 >= minDays).slice(0, opts.maxExpiries);

  const summary: ChainSummary = {
    symbol: chain.data.symbol,
    spot,
    asOf: chain.timestamp,
    iv30: chain.data.iv30 ? chain.data.iv30 / 100 : null,
    putCallVolume: ratio(all.filter((c) => c.type === "P").reduce((a, c) => a + c.volume, 0), all.filter((c) => c.type === "C").reduce((a, c) => a + c.volume, 0)),
    putCallOi: ratio(all.filter((c) => c.type === "P").reduce((a, c) => a + c.oi, 0), all.filter((c) => c.type === "C").reduce((a, c) => a + c.oi, 0)),
    expiries: chosen.map((e) => summarizeExpiry(byExpiry.get(e)!, e, spot, opts.now, opts.rate, opts.levels)).filter((x): x is ExpirySummary => x !== null),
  };

  if (opts.event) {
    const { date, timing } = opts.event;
    const post = expiries.find((e) => includesEvent(e, date, timing));
    const pre = [...expiries].reverse().find((e) => !includesEvent(e, date, timing) && yearsTo(e, opts.now) * 365 >= 1);
    if (post) {
      const sp = summarizeExpiry(byExpiry.get(post)!, post, spot, opts.now, opts.rate, []);
      const sq = pre ? summarizeExpiry(byExpiry.get(pre)!, pre, spot, opts.now, opts.rate, []) : null;
      let eventSigmaPct: number | null = null;
      if (sp?.atmIv && sq?.atmIv) {
        const Tpost = yearsTo(post, opts.now);
        const v = sp.atmIv ** 2 * Tpost - sq.atmIv ** 2 * Tpost;
        eventSigmaPct = v > 0 ? Math.sqrt(v) : null;
      }
      summary.event = { date, timing, preExpiry: pre ?? null, postExpiry: post, postStraddlePct: sp?.movePct ?? null, eventSigmaPct };
    }
  }
  return summary;
}
