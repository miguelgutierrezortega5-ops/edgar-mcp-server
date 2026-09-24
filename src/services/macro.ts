/** Macroeconomic data: FRED (St. Louis Fed) and the World Bank. Both are free; neither needs a key. */
import { cached, httpGet, HttpError } from "./http.js";

// ---------- FRED ----------

/** FRED_API_KEY, ignoring an unfilled placeholder (e.g. an optional field left empty in a Claude Desktop extension). */
function fredKey(): string | undefined {
  const k = process.env.FRED_API_KEY?.trim();
  return k && !k.startsWith("${") ? k : undefined;
}

export interface FredSeriesInfo {
  id: string;
  title: string;
  units: string;
  frequency: string;
  category: string;
  /** Third-party copyright holder: FRED allows only personal use of these series without the owner's permission. */
  copyright?: string;
}

/** Well-known FRED series, so they can be found and labelled without an API key. */
export const FRED_CATALOG: FredSeriesInfo[] = [
  // Interest rates
  { id: "FEDFUNDS", title: "Effective federal funds rate", units: "%", frequency: "Monthly", category: "rates" },
  { id: "DFF", title: "Effective federal funds rate (daily)", units: "%", frequency: "Daily", category: "rates" },
  { id: "SOFR", title: "Secured Overnight Financing Rate", units: "%", frequency: "Daily", category: "rates" },
  { id: "DGS3MO", title: "3-month Treasury yield", units: "%", frequency: "Daily", category: "rates" },
  { id: "DGS2", title: "2-year Treasury yield", units: "%", frequency: "Daily", category: "rates" },
  { id: "DGS10", title: "10-year Treasury yield", units: "%", frequency: "Daily", category: "rates" },
  { id: "DGS30", title: "30-year Treasury yield", units: "%", frequency: "Daily", category: "rates" },
  { id: "T10Y2Y", title: "10-year minus 2-year Treasury spread", units: "percentage points", frequency: "Daily", category: "rates" },
  { id: "T10Y3M", title: "10-year minus 3-month Treasury spread", units: "percentage points", frequency: "Daily", category: "rates" },
  { id: "DFII10", title: "10-year TIPS (real) yield", units: "%", frequency: "Daily", category: "rates" },
  { id: "T10YIE", title: "10-year breakeven inflation", units: "%", frequency: "Daily", category: "rates" },
  { id: "MORTGAGE30US", title: "30-year fixed mortgage rate", units: "%", frequency: "Weekly", category: "rates", copyright: "Freddie Mac" },
  { id: "BAMLH0A0HYM2", title: "US high-yield corporate bond spread (OAS)", units: "%", frequency: "Daily", category: "credit", copyright: "ICE Data Indices" },
  { id: "BAMLC0A0CM", title: "US investment-grade corporate bond spread (OAS)", units: "%", frequency: "Daily", category: "credit", copyright: "ICE Data Indices" },
  // Inflation
  { id: "CPIAUCSL", title: "Consumer price index (CPI-U)", units: "Index 1982-84=100", frequency: "Monthly", category: "inflation" },
  { id: "CPILFESL", title: "Core CPI (ex food and energy)", units: "Index 1982-84=100", frequency: "Monthly", category: "inflation" },
  { id: "PCEPI", title: "PCE price index", units: "Index 2017=100", frequency: "Monthly", category: "inflation" },
  { id: "PCEPILFE", title: "Core PCE price index (Fed's target measure)", units: "Index 2017=100", frequency: "Monthly", category: "inflation" },
  { id: "PPIACO", title: "Producer price index, all commodities", units: "Index 1982=100", frequency: "Monthly", category: "inflation" },
  // Growth and activity
  { id: "GDP", title: "Nominal GDP", units: "Billions of USD, SAAR", frequency: "Quarterly", category: "growth" },
  { id: "GDPC1", title: "Real GDP", units: "Billions of chained 2017 USD, SAAR", frequency: "Quarterly", category: "growth" },
  { id: "A191RL1Q225SBEA", title: "Real GDP growth (annualized quarterly)", units: "%", frequency: "Quarterly", category: "growth" },
  { id: "INDPRO", title: "Industrial production index", units: "Index 2017=100", frequency: "Monthly", category: "growth" },
  { id: "RSAFS", title: "Retail sales", units: "Millions of USD", frequency: "Monthly", category: "growth" },
  { id: "HOUST", title: "Housing starts", units: "Thousands of units, SAAR", frequency: "Monthly", category: "growth" },
  { id: "CSUSHPINSA", title: "Case-Shiller US home price index", units: "Index Jan 2000=100", frequency: "Monthly", category: "growth", copyright: "S&P Dow Jones Indices (S&P CoreLogic Case-Shiller)" },
  { id: "UMCSENT", title: "University of Michigan consumer sentiment", units: "Index 1966:Q1=100", frequency: "Monthly", category: "growth", copyright: "University of Michigan" },
  { id: "CP", title: "Corporate profits after tax", units: "Billions of USD, SAAR", frequency: "Quarterly", category: "growth" },
  // Labour
  { id: "UNRATE", title: "Unemployment rate", units: "%", frequency: "Monthly", category: "labor" },
  { id: "PAYEMS", title: "Nonfarm payrolls", units: "Thousands of persons", frequency: "Monthly", category: "labor" },
  { id: "ICSA", title: "Initial jobless claims", units: "Number", frequency: "Weekly", category: "labor" },
  { id: "CES0500000003", title: "Average hourly earnings, private", units: "USD per hour", frequency: "Monthly", category: "labor" },
  { id: "JTSJOL", title: "Job openings (JOLTS)", units: "Thousands", frequency: "Monthly", category: "labor" },
  // Money, markets, FX and commodities
  { id: "M2SL", title: "M2 money supply", units: "Billions of USD", frequency: "Monthly", category: "money" },
  { id: "WALCL", title: "Federal Reserve total assets", units: "Millions of USD", frequency: "Weekly", category: "money" },
  { id: "SP500", title: "S&P 500 index", units: "Index", frequency: "Daily", category: "markets", copyright: "S&P Dow Jones Indices" },
  { id: "VIXCLS", title: "CBOE volatility index (VIX)", units: "Index", frequency: "Daily", category: "markets", copyright: "Cboe Exchange" },
  { id: "NFCI", title: "Chicago Fed financial conditions index", units: "Index", frequency: "Weekly", category: "markets" },
  { id: "DTWEXBGS", title: "Trade-weighted US dollar index (broad)", units: "Index Jan 2006=100", frequency: "Daily", category: "fx" },
  { id: "DEXUSEU", title: "USD per euro", units: "USD", frequency: "Daily", category: "fx" },
  { id: "DEXMXUS", title: "Mexican pesos per USD", units: "MXN", frequency: "Daily", category: "fx" },
  { id: "DEXJPUS", title: "Japanese yen per USD", units: "JPY", frequency: "Daily", category: "fx" },
  { id: "DEXCHUS", title: "Chinese yuan per USD", units: "CNY", frequency: "Daily", category: "fx" },
  { id: "DCOILWTICO", title: "WTI crude oil price", units: "USD per barrel", frequency: "Daily", category: "commodities" },
  { id: "DCOILBRENTEU", title: "Brent crude oil price", units: "USD per barrel", frequency: "Daily", category: "commodities" },
  { id: "DHHNGSP", title: "Henry Hub natural gas price", units: "USD per MMBtu", frequency: "Daily", category: "commodities" },
  // Recession
  { id: "USREC", title: "NBER recession indicator (1 = recession)", units: "0/1", frequency: "Monthly", category: "growth" },
  { id: "SAHMREALTIME", title: "Sahm rule recession indicator", units: "percentage points", frequency: "Monthly", category: "labor" },
];

export const FRED_TRANSFORMS = {
  level: "lin",
  change: "chg",
  change_yoy: "ch1",
  pct_change: "pch",
  pct_change_yoy: "pc1",
  pct_change_annualized: "pca",
  log: "log",
} as const;
export type FredTransform = keyof typeof FRED_TRANSFORMS;

export const FRED_FREQUENCIES = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly", annual: "Annual" } as const;
export type FredFrequency = keyof typeof FRED_FREQUENCIES;

export interface Observation {
  date: string;
  value: number | null;
}

/** Parse fredgraph.csv (header `observation_date,<ID>`; missing values are '' or '.'). */
export function parseFredCsv(csv: string): Observation[] {
  const lines = csv.trim().split(/\r?\n/);
  if (!/^(observation_date|DATE),/i.test(lines[0] ?? "")) throw new Error("not a FRED CSV");
  return lines.slice(1).map((l) => {
    const [date, raw] = l.split(",");
    const v = raw === undefined || raw === "" || raw === "." ? null : Number(raw);
    return { date, value: v !== null && Number.isFinite(v) ? v : null };
  });
}

export interface FredQuery {
  start?: string;
  end?: string;
  transform?: FredTransform;
  frequency?: FredFrequency;
  /** How to aggregate to a lower frequency. */
  aggregation?: "avg" | "sum" | "eop";
}

export async function getFredSeries(id: string, q: FredQuery = {}): Promise<Observation[]> {
  const params = new URLSearchParams({ id });
  if (q.start) params.set("cosd", q.start);
  if (q.end) params.set("coed", q.end);
  if (q.transform && q.transform !== "level") params.set("transformation", FRED_TRANSFORMS[q.transform]);
  if (q.frequency) {
    params.set("fq", FRED_FREQUENCIES[q.frequency]);
    params.set("fam", q.aggregation ?? "avg");
  }
  const notFound = () => new Error(`FRED series '${id}' not found. Use macro_search_series to find the series ID.`);
  const csv = await httpGet<string>("fred", `/graph/fredgraph.csv?${params}`, { as: "text", ttl: 60 * 60 * 1000 }).catch((e) => {
    throw e instanceof HttpError && (e.status === 404 || e.status === 400) ? notFound() : e;
  });
  try {
    return parseFredCsv(csv);
  } catch {
    throw notFound();
  }
}

/** Series metadata: from the catalog, or FRED's API when FRED_API_KEY is set. */
export async function fredInfo(id: string): Promise<FredSeriesInfo | undefined> {
  const known = FRED_CATALOG.find((s) => s.id === id);
  if (known) return known;
  const key = fredKey();
  if (!key) return undefined;
  const res = await httpGet<{ seriess?: { id: string; title: string; units: string; frequency: string; notes?: string }[] }>(
    "fredapi",
    `/fred/series?series_id=${encodeURIComponent(id)}&api_key=${encodeURIComponent(key)}&file_type=json`,
    { ttl: 24 * 60 * 60 * 1000 },
  ).catch(() => undefined);
  const s = res?.seriess?.[0];
  if (!s) return undefined;
  // FRED marks third-party series with "Copyright" in their notes.
  return { id: s.id, title: s.title, units: s.units, frequency: s.frequency, category: "", copyright: /copyright/i.test(s.notes ?? "") ? "a third party (see the series notes on FRED)" : undefined };
}

export interface FredSearchHit extends FredSeriesInfo {
  popularity?: number;
  lastUpdated?: string;
}

/** Search FRED's 800,000+ series with FRED_API_KEY; otherwise the built-in catalog. */
export async function searchFred(query: string, limit: number): Promise<{ source: "fred" | "catalog"; hits: FredSearchHit[] }> {
  const key = fredKey();
  if (key) {
    const params = new URLSearchParams({ search_text: query, api_key: key, file_type: "json", limit: String(limit), order_by: "popularity", sort_order: "desc" });
    const res = await httpGet<{ seriess: { id: string; title: string; units: string; frequency: string; popularity?: number; last_updated?: string }[] }>(
      "fredapi",
      `/fred/series/search?${params}`,
      { ttl: 24 * 60 * 60 * 1000 },
    );
    return {
      source: "fred",
      hits: res.seriess.map((s) => ({ id: s.id, title: s.title, units: s.units, frequency: s.frequency, category: "", popularity: s.popularity, lastUpdated: s.last_updated })),
    };
  }
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = FRED_CATALOG.filter((s) => {
    const hay = `${s.id} ${s.title} ${s.category} ${s.units}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  return { source: "catalog", hits: (hits.length ? hits : FRED_CATALOG.filter((s) => words.some((w) => `${s.id} ${s.title} ${s.category}`.toLowerCase().includes(w)))).slice(0, limit) };
}

// ---------- World Bank ----------

export const WB_INDICATORS: Record<string, { id: string; label: string }> = {
  gdp_usd: { id: "NY.GDP.MKTP.CD", label: "GDP (current US$)" },
  gdp_growth: { id: "NY.GDP.MKTP.KD.ZG", label: "GDP growth (annual %)" },
  gdp_per_capita: { id: "NY.GDP.PCAP.CD", label: "GDP per capita (current US$)" },
  gdp_per_capita_ppp: { id: "NY.GDP.PCAP.PP.CD", label: "GDP per capita, PPP (current international $)" },
  inflation: { id: "FP.CPI.TOTL.ZG", label: "Inflation, consumer prices (annual %)" },
  unemployment: { id: "SL.UEM.TOTL.ZS", label: "Unemployment (% of labour force, ILO estimate)" },
  population: { id: "SP.POP.TOTL", label: "Population" },
  government_debt: { id: "GC.DOD.TOTL.GD.ZS", label: "Central government debt (% of GDP)" },
  current_account: { id: "BN.CAB.XOKA.GD.ZS", label: "Current account balance (% of GDP)" },
  exports: { id: "NE.EXP.GNFS.ZS", label: "Exports of goods and services (% of GDP)" },
  fdi_inflows: { id: "BX.KLT.DINV.WD.GD.ZS", label: "Foreign direct investment, net inflows (% of GDP)" },
  lending_rate: { id: "FR.INR.LEND", label: "Lending interest rate (%)" },
  real_interest_rate: { id: "FR.INR.RINR", label: "Real interest rate (%)" },
  market_cap: { id: "CM.MKT.LCAP.GD.ZS", label: "Market capitalization of listed companies (% of GDP)" },
  exchange_rate: { id: "PA.NUS.FCRF", label: "Official exchange rate (local currency per US$, period average)" },
};

interface WbCountry {
  id: string; // ISO3
  iso2Code: string;
  name: string;
  region: { value: string };
}

async function wbCountries(): Promise<WbCountry[]> {
  return cached("wb-countries", 7 * 24 * 60 * 60 * 1000, async () => {
    const res = await httpGet<[unknown, WbCountry[]]>("worldbank", "/v2/country?format=json&per_page=400");
    return { value: res[1], size: 50_000 };
  });
}

/** Resolve an ISO2/ISO3 code or an English country name ('Mexico', 'Spain'). */
export async function resolveCountry(input: string): Promise<WbCountry> {
  const q = input.trim().toLowerCase();
  const all = await wbCountries();
  const hit =
    all.find((c) => c.id.toLowerCase() === q || c.iso2Code.toLowerCase() === q) ??
    all.find((c) => c.name.toLowerCase() === q) ??
    all.find((c) => c.name.toLowerCase().startsWith(q)) ??
    all.find((c) => c.name.toLowerCase().includes(q));
  if (!hit) throw new Error(`Unknown country '${input}'. Use an ISO code ('MX', 'ESP', 'US') or the English name. Aggregates such as 'WLD' (world) or 'EUU' (EU) work too.`);
  return hit;
}

export interface WbRow {
  country: string;
  countryCode: string;
  year: number;
  value: number | null;
}

export async function getWorldBankIndicator(countryCodes: string[], indicatorId: string, startYear: number, endYear: number): Promise<{ label: string; rows: WbRow[] }> {
  const path = `/v2/country/${countryCodes.join(";")}/indicator/${encodeURIComponent(indicatorId)}?format=json&per_page=5000&date=${startYear}:${endYear}`;
  const res = await httpGet<[{ message?: { value: string }[]; total?: number }, { indicator: { value: string }; country: { value: string }; countryiso3code: string; date: string; value: number | null }[] | null]>(
    "worldbank",
    path,
    { ttl: 24 * 60 * 60 * 1000 },
  );
  if (res[0]?.message) throw new Error(`World Bank: ${res[0].message.map((m) => m.value).join("; ")}. Check the indicator ID.`);
  const data = res[1] ?? [];
  return {
    label: data[0]?.indicator.value ?? indicatorId,
    rows: data.map((d) => ({ country: d.country.value, countryCode: d.countryiso3code, year: Number(d.date), value: d.value })),
  };
}
