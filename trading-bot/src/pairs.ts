import { httpJson } from "./http.js";

// Dynamic pair list (like Freqtrade's VolumePairList + SpreadFilter + AgeFilter) from Binance's
// public market data: spot pairs that are trading, inside a daily-volume band, with a tight enough
// spread and some history, excluding stablecoins, fiat and leveraged tokens.

const BASE = process.env.BINANCE_DATA_URL ?? "https://data-api.binance.vision";
const NOT_COINS = new Set(["USDT", "USDC", "FDUSD", "TUSD", "DAI", "USDP", "BUSD", "PYUSD", "USD1", "USDE", "RLUSD", "XUSD", "EUR", "EURI", "AEUR", "TRY", "BRL", "ARS", "MXN", "GBP", "JPY", "PAXG", "WBTC", "WBETH", "BNSOL"]);
const LEVERAGED = /(UP|DOWN|BULL|BEAR)$/;
const DAY = 86_400_000;

export interface PairFilter {
  quote: string;
  minVolumeUsd: number;
  maxVolumeUsd: number;
  /** Largest bid/ask spread, in % of the price. */
  maxSpreadPct: number;
  /** Minimum days since listing (new listings behave erratically). */
  minAgeDays: number;
  /** Minimum trades in 24 h (filters out pairs with few, large prints). */
  minTrades: number;
  max: number;
  exclude: string[];
}

export interface PairPick {
  symbol: string;
  volumeUsd: number;
  spreadPct: number;
  trades: number;
}

interface Info {
  symbols: { symbol: string; baseAsset: string; quoteAsset: string; status: string; isSpotTradingAllowed?: boolean }[];
}
interface Ticker {
  symbol: string;
  quoteVolume: string;
  count: number;
}
interface Book {
  symbol: string;
  bidPrice: string;
  askPrice: string;
}

export async function selectPairs(f: PairFilter, now = Date.now()): Promise<PairPick[]> {
  const [info, tickers, books] = await Promise.all([
    httpJson<Info>(`${BASE}/api/v3/exchangeInfo?permissions=SPOT&symbolStatus=TRADING`),
    httpJson<Ticker[]>(`${BASE}/api/v3/ticker/24hr`),
    httpJson<Book[]>(`${BASE}/api/v3/ticker/bookTicker`),
  ]);
  const vol = new Map(tickers.map((t) => [t.symbol, t]));
  const book = new Map(books.map((b) => [b.symbol, b]));
  const exclude = new Set(f.exclude.map((s) => s.toUpperCase()));
  const candidates: (PairPick & { base: string })[] = [];
  for (const s of info.symbols) {
    if (s.quoteAsset !== f.quote || s.status !== "TRADING" || s.isSpotTradingAllowed === false) continue;
    if (NOT_COINS.has(s.baseAsset) || LEVERAGED.test(s.baseAsset) || exclude.has(s.baseAsset) || exclude.has(`${s.baseAsset}/${f.quote}`)) continue;
    const t = vol.get(s.symbol);
    const b = book.get(s.symbol);
    if (!t || !b) continue;
    const volumeUsd = Number(t.quoteVolume);
    const bid = Number(b.bidPrice);
    const ask = Number(b.askPrice);
    const spreadPct = bid > 0 && ask > 0 ? ((ask - bid) / ((ask + bid) / 2)) * 100 : Infinity;
    if (volumeUsd < f.minVolumeUsd || volumeUsd > f.maxVolumeUsd || spreadPct > f.maxSpreadPct || t.count < f.minTrades) continue;
    candidates.push({ symbol: `${s.baseAsset}/${f.quote}`, base: s.baseAsset, volumeUsd, spreadPct, trades: t.count });
  }
  // Most liquid of the band first; check listing age only for as many as needed.
  candidates.sort((a, b) => b.volumeUsd - a.volumeUsd);
  const picks: PairPick[] = [];
  for (const c of candidates) {
    if (picks.length >= f.max) break;
    if (f.minAgeDays > 0) {
      const first = await httpJson<[number][]>(`${BASE}/api/v3/klines?symbol=${c.base}${f.quote}&interval=1d&startTime=0&limit=1`);
      if (!first.length || now - first[0][0] < f.minAgeDays * DAY) continue;
    }
    picks.push({ symbol: c.symbol, volumeUsd: c.volumeUsd, spreadPct: c.spreadPct, trades: c.trades });
  }
  return picks;
}
