import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError, httpJson } from "../http.js";
import { firstZipEntry } from "./zip.js";

// Binance USDⓈ-M futures positioning, every 5 minutes: open interest, top traders' and everyone's
// long/short ratios, futures taker flow, plus funding rates. Two sources:
// - data.binance.vision, Binance's public archive: complete days up to yesterday, reachable from
//   anywhere. Used for backtests, learning and studies, and cached on disk (a day never changes).
// - fapi.binance.com: the last hours, for live trading. It refuses some countries (the US); then
//   the bot works with the archive alone, which leaves the current day without futures data.

const ARCHIVE = process.env.BINANCE_ARCHIVE_URL ?? "https://data.binance.vision";
const FAPI = process.env.BINANCE_FUTURES_URL ?? "https://fapi.binance.com";
const DAY = 86_400_000;
export const FUTURES_STEP = 5 * 60_000;

export interface FuturesPoint {
  time: number;
  /** Open interest in contracts (base currency) and in USD. */
  openInterest: number;
  openInterestValue: number;
  /** Top 20% of accounts by margin: long/short ratio by number of accounts and by position size. */
  topAccountsRatio: number;
  topPositionsRatio: number;
  /** All accounts: long/short ratio by number of accounts. */
  crowdRatio: number;
  /** Futures taker buy / sell volume. */
  takerRatio: number;
}

export interface FundingPoint {
  time: number;
  rate: number;
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const num = (s: string | undefined) => (s === undefined || s === "" ? NaN : Number(s));

export function parseMetricsCsv(csv: string): FuturesPoint[] {
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  const col = Object.fromEntries(header.split(",").map((h, i) => [h.trim(), i]));
  return lines
    .map((l) => l.split(","))
    .map((f) => ({
      time: Date.parse(`${f[col.create_time]}Z`.replace(" ", "T")),
      openInterest: num(f[col.sum_open_interest]),
      openInterestValue: num(f[col.sum_open_interest_value]),
      topAccountsRatio: num(f[col.count_toptrader_long_short_ratio]),
      topPositionsRatio: num(f[col.sum_toptrader_long_short_ratio]),
      crowdRatio: num(f[col.count_long_short_ratio]),
      takerRatio: num(f[col.sum_taker_long_short_vol_ratio]),
    }))
    .filter((p) => Number.isFinite(p.time))
    .sort((a, b) => a.time - b.time);
}

export class FuturesSource {
  /** False once fapi.binance.com refused us (geo-blocked): stop asking, in every instance. */
  private static liveOk = true;
  private get liveOk(): boolean {
    return FuturesSource.liveOk;
  }
  private set liveOk(v: boolean) {
    FuturesSource.liveOk = v;
  }

  constructor(
    private readonly cacheDir?: string,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  private async archiveFile(path: string, cacheName: string): Promise<string | null> {
    const cached = this.cacheDir ? join(this.cacheDir, cacheName) : null;
    if (cached && existsSync(cached)) return readFileSync(cached, "utf8");
    const res = await fetch(`${ARCHIVE}/${path}`, { signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) return null; // not published (yet), or no contract for the symbol
    if (!res.ok) throw new HttpError(res.status, path, await res.text());
    const csv = firstZipEntry(Buffer.from(await res.arrayBuffer()));
    if (cached) {
      mkdirSync(this.cacheDir!, { recursive: true });
      writeFileSync(cached, csv);
    }
    return csv;
  }

  /** 5-minute positioning from `since` to now (archive for past days, live API for the rest). */
  async metrics(symbol: string, since: number, now = Date.now()): Promise<FuturesPoint[]> {
    const out: FuturesPoint[] = [];
    const days: string[] = [];
    for (let t = Math.floor(since / DAY) * DAY; t < Math.floor(now / DAY) * DAY; t += DAY) days.push(day(t));
    for (let k = 0; k < days.length; k += 16) {
      const batch = await Promise.all(
        days.slice(k, k + 16).map((d) => this.archiveFile(`data/futures/um/daily/metrics/${symbol}/${symbol}-metrics-${d}.zip`, `${symbol}-metrics-${d}.csv`)),
      );
      for (const csv of batch) if (csv) out.push(...parseMetricsCsv(csv));
    }
    const lastArchived = out.at(-1)?.time ?? since;
    if (now - lastArchived > FUTURES_STEP * 2) out.push(...(await this.live(symbol, Math.max(since, lastArchived + 1))));
    return out.filter((p) => p.time >= since).sort((a, b) => a.time - b.time);
  }

  /** Recent points from fapi.binance.com (its history endpoints keep 30 days, 500 points per call). */
  private async live(symbol: string, since: number): Promise<FuturesPoint[]> {
    if (!this.liveOk) return [];
    const q = `symbol=${symbol}&period=5m&limit=500&startTime=${since}`;
    try {
      const [oi, top, topPos, crowd, taker] = await Promise.all([
        httpJson<{ timestamp: number; sumOpenInterest: string; sumOpenInterestValue: string }[]>(`${FAPI}/futures/data/openInterestHist?${q}`),
        httpJson<{ timestamp: number; longShortRatio: string }[]>(`${FAPI}/futures/data/topLongShortAccountRatio?${q}`),
        httpJson<{ timestamp: number; longShortRatio: string }[]>(`${FAPI}/futures/data/topLongShortPositionRatio?${q}`),
        httpJson<{ timestamp: number; longShortRatio: string }[]>(`${FAPI}/futures/data/globalLongShortAccountRatio?${q}`),
        httpJson<{ timestamp: number; buySellRatio: string }[]>(`${FAPI}/futures/data/takerlongshortRatio?${q}`),
      ]);
      const at = <T extends { timestamp: number }>(rows: T[]) => new Map(rows.map((r) => [r.timestamp, r]));
      const [mTop, mPos, mCrowd, mTaker] = [at(top), at(topPos), at(crowd), at(taker)];
      return oi.map((r) => ({
        time: r.timestamp,
        openInterest: num(r.sumOpenInterest),
        openInterestValue: num(r.sumOpenInterestValue),
        topAccountsRatio: num(mTop.get(r.timestamp)?.longShortRatio),
        topPositionsRatio: num(mPos.get(r.timestamp)?.longShortRatio),
        crowdRatio: num(mCrowd.get(r.timestamp)?.longShortRatio),
        takerRatio: num(mTaker.get(r.timestamp)?.buySellRatio),
      }));
    } catch (err) {
      if (err instanceof HttpError && (err.status === 451 || err.status === 403)) {
        const first = this.liveOk;
        this.liveOk = false;
        if (first) this.log(`La API de futuros de Binance no responde desde aquí (HTTP ${err.status}); se usa solo el archivo diario (hasta ayer).`);
        return [];
      }
      if (err instanceof HttpError && err.status === 400) return []; // no perpetual contract for this symbol
      throw err;
    }
  }

  /** Funding rates (every 8 h, or 4 h / 1 h on some contracts). */
  async funding(symbol: string, since: number, now = Date.now()): Promise<FundingPoint[]> {
    const out: FundingPoint[] = [];
    for (let t = Date.UTC(new Date(since).getUTCFullYear(), new Date(since).getUTCMonth(), 1); t < now; ) {
      const d = new Date(t);
      const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const csv = await this.archiveFile(`data/futures/um/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${month}.zip`, `${symbol}-funding-${month}.csv`);
      if (csv) for (const l of csv.trim().split(/\r?\n/).slice(1)) {
        const [time, , rate] = l.split(",");
        out.push({ time: Number(time), rate: Number(rate) });
      }
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
    if (this.liveOk) {
      try {
        const rows = await httpJson<{ fundingTime: number; fundingRate: string }[]>(`${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${Math.max(since, (out.at(-1)?.time ?? since) + 1)}&limit=1000`);
        out.push(...rows.map((r) => ({ time: r.fundingTime, rate: Number(r.fundingRate) })));
      } catch (err) {
        if (err instanceof HttpError && (err.status === 451 || err.status === 403)) this.liveOk = false;
        else if (!(err instanceof HttpError && err.status === 400)) throw err;
      }
    }
    return out.filter((p) => p.time >= since).sort((a, b) => a.time - b.time);
  }
}

/**
 * Positioning known at each bar's close, aligned to the bars: the latest 5-minute point at or before
 * the close (never a later one, so backtests do not peek). Missing data stays undefined.
 */
export function alignToBars<T extends { time: number }>(bars: { time: number }[], points: T[], barMs: number, maxAgeMs = 15 * 60_000): (T | undefined)[] {
  const out: (T | undefined)[] = [];
  let j = -1;
  for (const b of bars) {
    const close = b.time + barMs;
    while (j + 1 < points.length && points[j + 1].time <= close) j++;
    out.push(j >= 0 && close - points[j].time <= maxAgeMs ? points[j] : undefined);
  }
  return out;
}

/** % change of open interest over the 30 minutes before each bar's close (NaN without futures data). */
export function openInterestChange(candles: { time: number }[], futures: FuturesPoint[] | undefined, barMs: number): number[] {
  if (!futures?.length) return candles.map(() => NaN);
  const now = alignToBars(candles, futures, barMs);
  const before = alignToBars(candles.map((c) => ({ time: c.time - 30 * 60_000 })), futures, barMs);
  return candles.map((_, i) => (now[i] && before[i] ? (now[i]!.openInterest / before[i]!.openInterest - 1) * 100 : NaN));
}

/** For tests: ask the live API again. */
export function resetFuturesLive(): void {
  (FuturesSource as unknown as { liveOk: boolean }).liveOk = true;
}
