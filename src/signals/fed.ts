/**
 * Market-implied Fed path from two independent sources:
 *  1. 30-day fed funds futures (CBOT ZQ, via Yahoo) with the CME FedWatch method, anchored on the
 *     latest effective fed funds rate from the New York Fed and the FOMC calendar from the Fed.
 *  2. Kalshi's regulated "Fed decision" event contracts.
 */
import { httpGet } from "../services/http.js";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ZQ_CODES = "FGHJKMNQUVXZ";

export interface Meeting {
  /** Decision (second) day of the meeting, YYYY-MM-DD. */
  date: string;
  sep: boolean;
}

/** Parse the Fed's FOMC calendar page into decision dates. */
export function parseFomcCalendar(html: string): Meeting[] {
  const out: Meeting[] = [];
  const panels = html.split(/<h4><a id="\d+">(\d{4}) FOMC Meetings<\/a><\/h4>/);
  for (let i = 1; i < panels.length; i += 2) {
    const year = Number(panels[i]);
    const body = panels[i + 1].split(/<h4>/)[0];
    const re = /fomc-meeting__month[^>]*>\s*<strong>([^<]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)</g;
    for (let m = re.exec(body); m; m = re.exec(body)) {
      const months = m[1].split("/").map((s) => MONTHS.findIndex((n) => n.toLowerCase().startsWith(s.trim().toLowerCase().slice(0, 3))));
      const days = (m[2].match(/\d+/g) ?? []).map(Number);
      if (!days.length || months[0] < 0) continue;
      const end = days.at(-1)!;
      const wraps = days.length > 1 && end < days[0];
      const month = wraps && months.length > 1 ? months[1] : months[0];
      out.push({ date: `${year}-${String(month + 1).padStart(2, "0")}-${String(end).padStart(2, "0")}`, sep: m[2].includes("*") });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export async function getFomcMeetings(): Promise<Meeting[]> {
  const html = await httpGet<string>("fed", "/monetarypolicy/fomccalendars.htm", { as: "text", ttl: 24 * 3600 * 1000 });
  const meetings = parseFomcCalendar(html);
  if (!meetings.length) throw new Error("Could not read the FOMC calendar from federalreserve.gov.");
  return meetings;
}

export interface Effr {
  date: string;
  rate: number;
  targetFrom: number;
  targetTo: number;
}

export async function getEffr(): Promise<Effr> {
  const res = await httpGet<{ refRates: { effectiveDate: string; percentRate: number; targetRateFrom: number; targetRateTo: number }[] }>("nyfed", "/api/rates/unsecured/effr/last/1.json", { ttl: 3600 * 1000 });
  const r = res.refRates?.[0];
  if (!r) throw new Error("The New York Fed returned no effective fed funds rate.");
  return { date: r.effectiveDate, rate: r.percentRate, targetFrom: r.targetRateFrom, targetTo: r.targetRateTo };
}

/** Yahoo symbol of the 30-day fed funds future for a YYYY-MM month, e.g. 2026-11 → ZQX26.CBT. */
export const zqSymbol = (month: string) => `ZQ${ZQ_CODES[Number(month.slice(5, 7)) - 1]}${month.slice(2, 4)}.CBT`;

export function addMonths(month: string, n: number): string {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

const daysIn = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

/** Futures prices by YYYY-MM for `months` months starting at `from`; missing contracts are omitted. */
export async function getFedFundsFutures(from: string, months: number): Promise<Record<string, number>> {
  const list = Array.from({ length: months }, (_, i) => addMonths(from, i));
  const prices = await Promise.all(
    list.map(async (m) => {
      try {
        const res = await httpGet<{ chart: { result: { meta: { regularMarketPrice?: number } }[] | null } }>("yahoo", `/v8/finance/chart/${zqSymbol(m)}?range=5d&interval=1d`, { ttl: 10 * 60 * 1000 });
        return [m, res.chart.result?.[0]?.meta.regularMarketPrice] as const;
      } catch {
        return [m, undefined] as const;
      }
    }),
  );
  return Object.fromEntries(prices.filter((p): p is readonly [string, number] => typeof p[1] === "number" && p[1] > 50));
}

export interface MeetingPath {
  date: string;
  /** Expected rate before and after the meeting (effective fed funds, %). */
  before: number;
  after: number;
  changeBp: number;
  /** Probabilities of each outcome, assuming moves in 25 bp steps. */
  probs: { cut50: number; cut25: number; hold: number; hike25: number; hike50: number };
  /** How r_after was obtained: the next month's average (clean) or this month's average (noisier). */
  method: "next_month" | "same_month";
}

function stepProbs(changeBp: number): MeetingPath["probs"] {
  const p = { cut50: 0, cut25: 0, hold: 0, hike25: 0, hike50: 0 };
  const x = Math.min(Math.abs(changeBp) / 25, 2);
  const [one, two] = changeBp >= 0 ? (["hike25", "hike50"] as const) : (["cut25", "cut50"] as const);
  if (x <= 1) {
    p[one] = x;
    p.hold = 1 - x;
  } else {
    p[two] = x - 1;
    p[one] = 2 - x;
  }
  return p;
}

/**
 * CME FedWatch-style path: the rate after a meeting is the next month's futures average when that
 * month has no meeting; otherwise it is solved from this month's average, d days at the old rate.
 */
export function impliedPath(effr: number, meetings: Meeting[], futures: Record<string, number>): MeetingPath[] {
  const months = new Set(meetings.map((m) => m.date.slice(0, 7)));
  const out: MeetingPath[] = [];
  let before = effr;
  for (const m of meetings) {
    const month = m.date.slice(0, 7);
    const next = addMonths(month, 1);
    const avg = (mm: string) => (futures[mm] !== undefined ? 100 - futures[mm] : undefined);
    let after: number | undefined;
    let method: MeetingPath["method"] = "next_month";
    if (!months.has(next) && avg(next) !== undefined) after = avg(next);
    else if (avg(month) !== undefined) {
      const N = daysIn(month);
      const d = Number(m.date.slice(8, 10));
      if (N - d >= 1) after = (avg(month)! * N - d * before) / (N - d);
      method = "same_month";
    }
    if (after === undefined) break;
    const changeBp = (after - before) * 100;
    out.push({ date: m.date, before, after, changeBp, probs: stepProbs(changeBp), method });
    before = after;
  }
  return out;
}

export interface KalshiOutcome {
  label: string;
  probability: number | null;
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number | null;
}

export interface KalshiEvent {
  ticker: string;
  title: string;
  closes: string | null;
  outcomes: KalshiOutcome[];
}

interface KalshiMarket {
  ticker: string;
  title?: string;
  yes_sub_title?: string;
  subtitle?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
  volume_fp?: string;
  close_time?: string;
  status?: string;
}

const num = (s: string | undefined) => (s === undefined || s === null || s === "" ? null : Number(s));

/**
 * Mid of bid/ask when both quote, else the last trade. Within a mutually exclusive event (one
 * outcome must happen) prices are normalized to sum 1; independent yes/no markets are left as is.
 */
export function kalshiOutcomes(markets: KalshiMarket[], mutuallyExclusive: boolean): KalshiOutcome[] {
  const rows = markets.map((m) => {
    const bid = num(m.yes_bid_dollars);
    const ask = num(m.yes_ask_dollars);
    const last = num(m.last_price_dollars);
    const raw = bid !== null && ask !== null && bid > 0 && ask > 0 && ask < 1 ? (bid + ask) / 2 : last;
    return { label: m.yes_sub_title || m.subtitle || m.title || m.ticker, raw, bid, ask, last, volume: num(m.volume_fp) };
  });
  const total = rows.reduce((a, r) => a + (r.raw ?? 0), 0);
  return rows.map(({ raw, ...r }) => ({ ...r, probability: raw === null ? null : mutuallyExclusive && total > 0 ? raw / total : raw }));
}

export async function getKalshiSeries(series: string): Promise<KalshiEvent[]> {
  const res = await httpGet<{ events?: { event_ticker: string; title: string; mutually_exclusive?: boolean; markets?: KalshiMarket[] }[] }>(
    "kalshi",
    `/trade-api/v2/events?series_ticker=${encodeURIComponent(series)}&status=open&with_nested_markets=true&limit=50`,
    { ttl: 5 * 60 * 1000 },
  );
  return (res.events ?? [])
    .map((e) => ({
      ticker: e.event_ticker,
      title: e.title,
      closes: e.markets?.[0]?.close_time ?? null,
      outcomes: kalshiOutcomes(e.markets ?? [], e.mutually_exclusive === true && (e.markets?.length ?? 0) > 1),
    }))
    .sort((a, b) => (a.closes ?? "").localeCompare(b.closes ?? ""));
}
