/** Crowd sentiment as numbers: CNN Fear & Greed (7 components) and prediction-market odds. */
import { httpGet } from "../services/http.js";
import { getKalshiSeries, type KalshiEvent } from "./fed.js";
import { percentileRank } from "./stats.js";

interface FgComponent {
  score: number;
  rating: string;
  data?: { x: number; y: number }[];
}

interface FgResponse {
  fear_and_greed: { score: number; rating: string; timestamp: string; previous_close: number; previous_1_week: number; previous_1_month: number; previous_1_year: number };
  fear_and_greed_historical?: { data?: { x: number; y: number }[] };
  [component: string]: unknown;
}

const COMPONENTS: Record<string, string> = {
  market_momentum_sp500: "S&P 500 vs its 125-day average",
  stock_price_strength: "52-week highs vs lows (NYSE)",
  stock_price_breadth: "McClellan volume summation (breadth)",
  put_call_options: "5-day put/call ratio",
  market_volatility_vix: "VIX vs its 50-day average",
  safe_haven_demand: "Stocks vs bonds, 20-day returns",
  junk_bond_demand: "Junk vs investment-grade spread",
};

export interface FearGreed {
  score: number;
  rating: string;
  asOf: string;
  previousClose: number;
  oneWeekAgo: number;
  oneMonthAgo: number;
  oneYearAgo: number;
  /** Percentile of today's score within the history CNN returns (about a year). */
  percentile: number | null;
  historyDays: number;
  components: { key: string; label: string; score: number; rating: string }[];
}

export async function getFearGreed(): Promise<FearGreed> {
  const r = await httpGet<FgResponse>("cnn", "/index/fearandgreed/graphdata", { ttl: 30 * 60 * 1000 });
  const f = r.fear_and_greed;
  const hist = (r.fear_and_greed_historical?.data ?? []).map((p) => p.y).filter((y) => Number.isFinite(y));
  return {
    score: f.score,
    rating: f.rating,
    asOf: f.timestamp,
    previousClose: f.previous_close,
    oneWeekAgo: f.previous_1_week,
    oneMonthAgo: f.previous_1_month,
    oneYearAgo: f.previous_1_year,
    percentile: hist.length ? percentileRank(hist, f.score) : null,
    historyDays: hist.length,
    components: Object.entries(COMPONENTS)
      .map(([key, label]) => {
        const c = r[key] as FgComponent | undefined;
        return c ? { key, label, score: c.score, rating: c.rating } : null;
      })
      .filter((c): c is NonNullable<typeof c> => c !== null),
  };
}

// ---------- prediction markets ----------

export interface PredictionMarket {
  source: "Polymarket" | "Kalshi";
  event: string;
  question: string;
  outcomes: { label: string; probability: number | null }[];
  volume: number | null;
  closes: string | null;
}

interface PolyMarket {
  question: string;
  outcomes?: string;
  outcomePrices?: string;
  volume?: string | number;
  endDate?: string;
  closed?: boolean;
  active?: boolean;
}

export async function searchPolymarket(query: string, limit: number): Promise<PredictionMarket[]> {
  const res = await httpGet<{ events?: { title: string; closed?: boolean; markets?: PolyMarket[] }[] }>(
    "polymarket",
    `/public-search?q=${encodeURIComponent(query)}&limit_per_type=${limit}&events_status=active`,
    { ttl: 10 * 60 * 1000 },
  );
  const out: PredictionMarket[] = [];
  for (const e of res.events ?? []) {
    if (e.closed) continue;
    for (const m of e.markets ?? []) {
      if (m.closed || m.active === false) continue;
      let labels: string[] = [];
      let prices: number[] = [];
      try {
        labels = JSON.parse(m.outcomes ?? "[]");
        prices = (JSON.parse(m.outcomePrices ?? "[]") as string[]).map(Number);
      } catch {
        continue;
      }
      out.push({
        source: "Polymarket",
        event: e.title,
        question: m.question,
        outcomes: labels.map((label, i) => ({ label, probability: Number.isFinite(prices[i]) ? prices[i] : null })),
        volume: m.volume !== undefined ? Number(m.volume) : null,
        closes: m.endDate ?? null,
      });
    }
  }
  return out.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0)).slice(0, limit * 3);
}

/** Kalshi series whose title matches every word of the query (Economics and Financials categories). */
export async function searchKalshiSeries(query: string, limit: number): Promise<{ ticker: string; title: string }[]> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lists = await Promise.all(
    ["Economics", "Financials"].map((cat) =>
      httpGet<{ series?: { ticker: string; title: string }[] }>("kalshi", `/trade-api/v2/series?category=${cat}`, { ttl: 24 * 3600 * 1000 }).then((r) => r.series ?? []),
    ),
  );
  return lists
    .flat()
    .filter((s) => words.every((w) => `${s.title} ${s.ticker}`.toLowerCase().includes(w)))
    .slice(0, limit);
}

export async function kalshiMarkets(series: string[], limitPerSeries: number): Promise<PredictionMarket[]> {
  const events: KalshiEvent[][] = await Promise.all(series.map((s) => getKalshiSeries(s).catch(() => [])));
  return events.flatMap((list) =>
    list.slice(0, limitPerSeries).map((e) => ({
      source: "Kalshi" as const,
      event: e.ticker,
      question: e.title,
      outcomes: e.outcomes.map((o) => ({ label: o.label, probability: o.probability })),
      volume: e.outcomes.reduce((a, o) => a + (o.volume ?? 0), 0),
      closes: e.closes,
    })),
  );
}
