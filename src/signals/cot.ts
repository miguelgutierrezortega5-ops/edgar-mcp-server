/**
 * CFTC Commitments of Traders positioning (weekly, Tuesday data released Friday): leveraged funds and
 * asset managers for financial futures (Traders in Financial Futures report) and non-commercial
 * speculators for commodities (Legacy report), ranked against their own history.
 */
import { httpGet } from "../services/http.js";
import { percentileRank, zScore } from "./stats.js";

type Dataset = "tff" | "legacy";
const DATASETS: Record<Dataset, string> = { tff: "gpe5-46if", legacy: "6dca-aqww" };

export const CONTRACTS: Record<string, { code: string; name: string; dataset: Dataset }> = {
  sp500: { code: "13874A", name: "E-mini S&P 500", dataset: "tff" },
  nasdaq100: { code: "209742", name: "E-mini Nasdaq-100", dataset: "tff" },
  russell2000: { code: "239742", name: "E-mini Russell 2000", dataset: "tff" },
  vix: { code: "1170E1", name: "VIX futures", dataset: "tff" },
  ust2y: { code: "042601", name: "2-year Treasury note", dataset: "tff" },
  ust5y: { code: "044601", name: "5-year Treasury note", dataset: "tff" },
  ust10y: { code: "043602", name: "10-year Treasury note", dataset: "tff" },
  ustbond: { code: "020601", name: "Treasury bond", dataset: "tff" },
  mxn: { code: "095741", name: "Mexican peso", dataset: "tff" },
  eur: { code: "099741", name: "Euro", dataset: "tff" },
  jpy: { code: "097741", name: "Japanese yen", dataset: "tff" },
  bitcoin: { code: "133741", name: "Bitcoin (CME)", dataset: "tff" },
  gold: { code: "088691", name: "Gold (COMEX)", dataset: "legacy" },
  silver: { code: "084691", name: "Silver (COMEX)", dataset: "legacy" },
  copper: { code: "085692", name: "Copper (COMEX)", dataset: "legacy" },
  wti: { code: "067651", name: "WTI crude oil (NYMEX)", dataset: "legacy" },
};

type Row = Record<string, string>;

export interface Positioning {
  key: string;
  name: string;
  date: string;
  openInterest: number;
  /** Speculative group: leveraged funds (TFF) or non-commercials (Legacy). */
  specLabel: string;
  specNet: number;
  specNetPctOi: number;
  change1w: number;
  change4w: number;
  /** Percentile and z-score of specNet within the requested history window. */
  percentile: number;
  z: number;
  /** Second group: asset managers (TFF) or commercials/hedgers (Legacy). */
  otherLabel: string;
  otherNet: number;
  otherPercentile: number;
  weeks: number;
}

const n = (r: Row, k: string) => Number(r[k] ?? 0);

export function summarizePositioning(key: string, rows: Row[]): Positioning | null {
  const c = CONTRACTS[key];
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => b.report_date_as_yyyy_mm_dd.localeCompare(a.report_date_as_yyyy_mm_dd));
  const spec = (r: Row) => (c.dataset === "tff" ? n(r, "lev_money_positions_long") - n(r, "lev_money_positions_short") : n(r, "noncomm_positions_long_all") - n(r, "noncomm_positions_short_all"));
  const other = (r: Row) => (c.dataset === "tff" ? n(r, "asset_mgr_positions_long") - n(r, "asset_mgr_positions_short") : n(r, "comm_positions_long_all") - n(r, "comm_positions_short_all"));
  const specSeries = sorted.map(spec);
  const otherSeries = sorted.map(other);
  const latest = sorted[0];
  const oi = n(latest, "open_interest_all");
  return {
    key,
    name: c.name,
    date: latest.report_date_as_yyyy_mm_dd.slice(0, 10),
    openInterest: oi,
    specLabel: c.dataset === "tff" ? "Leveraged funds" : "Non-commercials",
    specNet: specSeries[0],
    specNetPctOi: oi > 0 ? specSeries[0] / oi : NaN,
    change1w: specSeries.length > 1 ? specSeries[0] - specSeries[1] : NaN,
    change4w: specSeries.length > 4 ? specSeries[0] - specSeries[4] : NaN,
    percentile: percentileRank(specSeries, specSeries[0]),
    z: zScore(specSeries, specSeries[0]),
    otherLabel: c.dataset === "tff" ? "Asset managers" : "Commercials (hedgers)",
    otherNet: otherSeries[0],
    otherPercentile: percentileRank(otherSeries, otherSeries[0]),
    weeks: sorted.length,
  };
}

export async function getPositioning(key: string, weeks: number): Promise<Positioning | null> {
  const c = CONTRACTS[key];
  if (!c) throw new Error(`Unknown contract '${key}'. Use one of: ${Object.keys(CONTRACTS).join(", ")}.`);
  const where = encodeURIComponent(`cftc_contract_market_code='${c.code}'`);
  const rows = await httpGet<Row[]>("cftc", `/resource/${DATASETS[c.dataset]}.json?$where=${where}&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=${weeks}`, { ttl: 6 * 3600 * 1000 });
  return summarizePositioning(key, rows);
}
