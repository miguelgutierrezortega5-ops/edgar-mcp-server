/**
 * Earnings expectations from Nasdaq's public API (consensus from Zacks): next report date, EPS
 * consensus with the 4-week revision count, the surprise history, and a dated earnings calendar.
 */
import { httpGet } from "../services/http.js";
import { parseNum } from "./stats.js";

interface NasdaqEnvelope<T> {
  data: T | null;
  status?: { rCode?: number; bCodeMessage?: { errorMessage?: string }[] | null };
}

async function nasdaq<T>(path: string): Promise<T> {
  const res = await httpGet<NasdaqEnvelope<T>>("nasdaq", path, { ttl: 60 * 60 * 1000 });
  if (!res.data) throw new Error(`Nasdaq returned no data for ${path.split("?")[0]} (${res.status?.bCodeMessage?.[0]?.errorMessage ?? "unknown symbol"}). US tickers only.`);
  return res.data;
}

export interface ForecastRow {
  period: string;
  consensus: number | null;
  high: number | null;
  low: number | null;
  estimates: number | null;
  revisionsUp: number | null;
  revisionsDown: number | null;
}

export interface SurpriseRow {
  quarter: string;
  reported: string;
  eps: number | null;
  consensus: number | null;
  surprisePct: number | null;
}

export interface EarningsExpectations {
  symbol: string;
  nextDate: string | null;
  timing: "before_open" | "after_close" | null;
  dateText: string | null;
  quarterly: ForecastRow[];
  yearly: ForecastRow[];
  surprises: SurpriseRow[];
}

interface ForecastTable {
  rows?: { fiscalEnd: string; consensusEPSForecast: unknown; highEPSForecast: unknown; lowEPSForecast: unknown; noOfEstimates: unknown; up: unknown; down: unknown }[];
}

const forecastRows = (t?: ForecastTable): ForecastRow[] =>
  (t?.rows ?? []).map((r) => ({
    period: r.fiscalEnd,
    consensus: parseNum(r.consensusEPSForecast),
    high: parseNum(r.highEPSForecast),
    low: parseNum(r.lowEPSForecast),
    estimates: parseNum(r.noOfEstimates),
    revisionsUp: parseNum(r.up),
    revisionsDown: parseNum(r.down),
  }));

/** "…report earnings on 10/29/2026 before market open…" → 2026-10-29, before_open. */
export function parseReportText(text: string | null | undefined): { date: string | null; timing: EarningsExpectations["timing"] } {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text ?? "");
  const date = m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
  const timing = /before market open/i.test(text ?? "") ? "before_open" : /after market close/i.test(text ?? "") ? "after_close" : null;
  return { date, timing };
}

export async function getEarningsExpectations(symbol: string): Promise<EarningsExpectations> {
  const s = encodeURIComponent(symbol.toUpperCase());
  const [forecast, surprise, date] = await Promise.all([
    nasdaq<{ quarterlyForecast?: ForecastTable; yearlyForecast?: ForecastTable }>(`/api/analyst/${s}/earnings-forecast`),
    nasdaq<{ earningsSurpriseTable?: { rows?: { fiscalQtrEnd: string; dateReported: string; eps: unknown; consensusForecast: unknown; percentageSurprise: unknown }[] } }>(`/api/company/${s}/earnings-surprise`).catch(() => null),
    nasdaq<{ reportText?: string }>(`/api/analyst/${s}/earnings-date`).catch(() => null),
  ]);
  const { date: nextDate, timing } = parseReportText(date?.reportText);
  return {
    symbol: symbol.toUpperCase(),
    nextDate,
    timing,
    dateText: date?.reportText?.replace(/\s+/g, " ").trim() ?? null,
    quarterly: forecastRows(forecast.quarterlyForecast),
    yearly: forecastRows(forecast.yearlyForecast),
    surprises: (surprise?.earningsSurpriseTable?.rows ?? []).map((r) => ({
      quarter: r.fiscalQtrEnd,
      reported: r.dateReported,
      eps: parseNum(r.eps),
      consensus: parseNum(r.consensusForecast),
      surprisePct: parseNum(r.percentageSurprise) !== null ? parseNum(r.percentageSurprise)! / 100 : null,
    })),
  };
}

export interface CalendarRow {
  symbol: string;
  name: string;
  marketCap: number | null;
  timing: string;
  quarter: string;
  epsForecast: number | null;
  estimates: number | null;
  lastYearEps: number | null;
}

export async function getEarningsCalendar(date: string): Promise<CalendarRow[]> {
  const d = await nasdaq<{ rows?: { symbol: string; name: string; marketCap: string; time: string; fiscalQuarterEnding: string; epsForecast: string; noOfEsts: string; lastYearEPS: string }[] | null }>(
    `/api/calendar/earnings?date=${date}`,
  );
  const timing = (t: string) => (t === "time-pre-market" ? "before open" : t === "time-after-hours" ? "after close" : "not supplied");
  return (d.rows ?? []).map((r) => ({
    symbol: r.symbol,
    name: r.name,
    marketCap: parseNum(r.marketCap),
    timing: timing(r.time),
    quarter: r.fiscalQuarterEnding,
    epsForecast: parseNum(r.epsForecast),
    estimates: parseNum(r.noOfEsts),
    lastYearEps: parseNum(r.lastYearEPS),
  }));
}
