import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { companyField, resolveCompany } from "../services/companies.js";
import { fmtNum, mdTable, render, responseFormatField } from "../services/format.js";
import { httpGet } from "../services/http.js";
import { getSubmissions, recentFilings } from "../services/filings.js";
import { firstAvailable, getCompanyFacts, conceptSeries } from "../services/xbrl.js";
import { STATEMENTS } from "../services/statements.js";
import { registerReadTool } from "./register.js";

interface Chart {
  chart: {
    result: {
      meta: { symbol: string; currency?: string; longName?: string; exchangeName?: string; regularMarketPrice?: number; regularMarketTime?: number; fiftyTwoWeekHigh?: number; fiftyTwoWeekLow?: number; chartPreviousClose?: number };
      timestamp?: number[];
      indicators: { quote: { close: (number | null)[]; volume: (number | null)[] }[]; adjclose?: { adjclose: (number | null)[] }[] };
    }[] | null;
    error?: { description?: string } | null;
  };
}

async function getChart(symbol: string, range: string, interval: string): Promise<Chart["chart"]["result"] & object> {
  const res = await httpGet<Chart>("yahoo", `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&events=div,split`, { ttl: 5 * 60 * 1000 });
  if (!res.chart.result?.length) throw new Error(`No price data for '${symbol}': ${res.chart.error?.description ?? "unknown symbol"}. Non-US listings need a Yahoo suffix (e.g. 'SAP.DE', 'MC.PA', 'SHOP.TO').`);
  return res.chart.result;
}

const RANGE_INTERVAL: Record<string, string> = { "5d": "1d", "1mo": "1d", "3mo": "1d", "6mo": "1d", ytd: "1d", "1y": "1d", "2y": "1wk", "5y": "1wk", "10y": "1mo", max: "1mo" };

function sample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = (items.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => items[Math.round(i * step)]);
}

export function registerMarketTools(server: McpServer): void {
  registerReadTool(
    server,
    "market_get_stock_price",
    {
      title: "Get stock price history",
      description: `Get the current price and price history for a ticker (any exchange: US tickers as-is, others with a Yahoo suffix like 'SAP.DE', 'MC.PA', 'SHOP.TO', '7203.T').
Returns current price, 52-week range, return over the range, max drawdown, and a sampled price table (split/dividend-adjusted closes).
Source: Yahoo Finance's public chart endpoint (unofficial; may occasionally be unavailable).`,
      inputSchema: {
        symbol: z.string().min(1).max(20).describe("Ticker, e.g. 'AAPL', 'BRK-B', 'SAP.DE'."),
        range: z.enum(["5d", "1mo", "3mo", "6mo", "ytd", "1y", "2y", "5y", "10y", "max"]).default("1y").describe("History range (default 1y)."),
        max_points: z.number().int().min(2).max(300).default(24).describe("Rows in the price table (default 24, evenly sampled)."),
        response_format: responseFormatField,
      },
    },
    async ({ symbol, range, max_points, response_format }) => {
      const [r] = await getChart(symbol.toUpperCase(), range, RANGE_INTERVAL[range]);
      const closes = r.indicators.adjclose?.[0]?.adjclose ?? r.indicators.quote[0].close;
      const series = (r.timestamp ?? [])
        .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i], volume: r.indicators.quote[0].volume[i] }))
        .filter((p): p is { date: string; close: number; volume: number | null } => typeof p.close === "number");
      let peak = -Infinity;
      let maxDd = 0;
      for (const p of series) {
        peak = Math.max(peak, p.close);
        maxDd = Math.min(maxDd, p.close / peak - 1);
      }
      const first = series[0];
      const last = series.at(-1);
      const m = r.meta;
      const data = {
        symbol: m.symbol,
        name: m.longName,
        exchange: m.exchangeName,
        currency: m.currency,
        price: m.regularMarketPrice,
        asOf: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : undefined,
        week52High: m.fiftyTwoWeekHigh,
        week52Low: m.fiftyTwoWeekLow,
        range,
        rangeReturn: first && last ? last.close / first.close - 1 : null,
        maxDrawdown: maxDd,
        prices: sample(series, max_points),
      };
      return render(response_format, data, (d) =>
        [
          `# ${d.name ?? d.symbol} (${d.symbol}, ${d.exchange ?? "?"}) — ${d.currency ?? ""}`,
          "",
          `- **Price**: ${d.price ?? "–"} (as of ${d.asOf ?? "–"})`,
          `- **52-week range**: ${d.week52Low ?? "–"} – ${d.week52High ?? "–"}`,
          `- **Return over ${d.range}**: ${fmtNum(d.rangeReturn, "%")} · max drawdown ${fmtNum(d.maxDrawdown, "%")}`,
          "",
          mdTable(["Date", "Adj. close", "Volume"], d.prices.map((p) => [p.date, p.close.toFixed(2), fmtNum(p.volume)])),
          "",
          "_Source: Yahoo Finance (unofficial). Adjusted for splits and dividends._",
        ].join("\n"),
      );
    },
  );

  registerReadTool(
    server,
    "market_get_treasury_yields",
    {
      title: "Get US Treasury yield curve",
      description: `Get the official US Treasury daily par yield curve (1 month to 30 years) from treasury.gov — useful as the risk-free rate in valuations (typically the 10-year).
Returns the latest available date by default, or the closest date on/before \`date\`.`,
      inputSchema: {
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date (YYYY-MM-DD); default latest."),
        response_format: responseFormatField,
      },
    },
    async ({ date, response_format }) => {
      const year = date ? date.slice(0, 4) : String(new Date().getUTCFullYear());
      const fetchYear = (y: string) =>
        httpGet<string>("treasury", `/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${y}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${y}&page&_format=csv`, { as: "text", ttl: 60 * 60 * 1000 });
      let csv = await fetchYear(year);
      if (csv.trim().split("\n").length < 2) csv = await fetchYear(String(Number(year) - 1));
      const [header, ...lines] = csv.trim().split(/\r?\n/);
      const cols = header.split(",").map((c) => c.replace(/"/g, ""));
      const rows = lines.map((l) => {
        const v = l.split(",");
        const [mm, dd, yyyy] = v[0].split("/");
        return { date: `${yyyy}-${mm}-${dd}`, yields: Object.fromEntries(cols.slice(1).map((c, i) => [c, v[i + 1] === "" ? null : Number(v[i + 1])])) };
      });
      rows.sort((a, b) => b.date.localeCompare(a.date));
      const row = date ? rows.find((r) => r.date <= date) : rows[0];
      if (!row) throw new Error(`No Treasury data on or before ${date}.`);
      return render(response_format, row, (d) =>
        [`# US Treasury par yield curve — ${d.date}`, "", mdTable(Object.keys(d.yields), [Object.values(d.yields).map((v) => (v === null ? "–" : `${v.toFixed(2)}%`))]), "", "_Source: U.S. Department of the Treasury._"].join("\n"),
      );
    },
  );

  registerReadTool(
    server,
    "market_get_valuation",
    {
      title: "Get valuation multiples",
      description: `Compute valuation multiples for a US-listed SEC filer by combining the live share price (Yahoo) with trailing-twelve-month fundamentals from SEC filings:
market cap, enterprise value, P/E, P/S, P/FCF, EV/Revenue, EV/EBIT, earnings yield and FCF yield. TTM = sum of the last 4 reported quarters.`,
      inputSchema: { company: companyField, response_format: responseFormatField },
    },
    async ({ company, response_format }) => {
      const reg = await resolveCompany(company);
      if (!reg.ticker) throw new Error(`No ticker known for ${reg.name}; valuation needs a listed share price.`);
      const [facts, chart] = await Promise.all([getCompanyFacts(reg.cik), getChart(reg.ticker, "5d", "1d")]);
      const price = chart[0].meta.regularMarketPrice;
      if (price === undefined) throw new Error(`No current price for ${reg.ticker}.`);

      const lineSeries = (key: string) => {
        const def = [...STATEMENTS.income, ...STATEMENTS.balance, ...STATEMENTS.cashflow].find((d) => d.key === key)!;
        return firstAvailable(facts, def.candidates, "quarterly", def.unit);
      };
      const ttm = (key: string) => {
        const pts = [...lineSeries(key).values()].filter((p) => p.start).sort((a, b) => a.end.localeCompare(b.end)).slice(-4);
        return pts.length === 4 ? { value: pts.reduce((s, p) => s + p.val, 0), through: pts[3].end } : null;
      };
      const latest = (key: string) => [...lineSeries(key).values()].sort((a, b) => a.end.localeCompare(b.end)).at(-1);

      const sharesPts = [...conceptSeries(facts, "dei:EntityCommonStockSharesOutstanding", "quarterly", "shares").values()].sort((a, b) => a.end.localeCompare(b.end));
      const shares = sharesPts.at(-1)?.val ?? latest("diluted_shares")?.val;
      if (!shares) throw new Error(`Could not determine shares outstanding for ${facts.entityName}.`);

      const revenue = ttm("revenue");
      const netIncome = ttm("net_income");
      const ebit = ttm("operating_income");
      const cfo = ttm("cfo");
      const capex = ttm("capex");
      const fcf = cfo && capex ? cfo.value - capex.value : null;
      const cash = (latest("cash")?.val ?? 0) + (latest("short_term_investments")?.val ?? 0);
      const debt = latest("long_term_debt")?.val ?? 0;
      const marketCap = price * shares;
      const ev = marketCap + debt - cash;
      const r = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null || b <= 0 ? null : a / b);

      // The SEC's XBRL dataset can lag behind the filing index; flag when newer reports exist.
      const ttmThrough = revenue?.through ?? netIncome?.through;
      const latestReport = recentFilings(await getSubmissions(reg.cik)).find((f) => /^(10-Q|10-K|20-F|40-F)$/.test(f.form));
      const staleWarning =
        ttmThrough && latestReport?.reportDate && latestReport.reportDate > ttmThrough
          ? `The ${latestReport.form} for the period ending ${latestReport.reportDate} (filed ${latestReport.filingDate}) is not yet in the SEC's XBRL dataset, so TTM figures stop at ${ttmThrough}.`
          : undefined;

      const data = {
        company: facts.entityName,
        ticker: reg.ticker,
        price,
        currency: chart[0].meta.currency,
        sharesOutstanding: shares,
        marketCap,
        enterpriseValue: ev,
        ttmThrough,
        staleWarning,
        ttm: { revenue: revenue?.value ?? null, netIncome: netIncome?.value ?? null, ebit: ebit?.value ?? null, fcf },
        balance: { cashAndShortTermInvestments: cash, longTermDebt: debt },
        multiples: {
          pe: r(marketCap, netIncome?.value),
          ps: r(marketCap, revenue?.value),
          pFcf: r(marketCap, fcf),
          evRevenue: r(ev, revenue?.value),
          evEbit: r(ev, ebit?.value),
          earningsYield: r(netIncome?.value, marketCap),
          fcfYield: r(fcf, marketCap),
        },
      };
      return render(response_format, data, (d) =>
        [
          `# ${d.company} (${d.ticker}) — valuation`,
          "",
          `Price ${d.price} ${d.currency ?? ""} × ${fmtNum(d.sharesOutstanding)} shares = **market cap ${fmtNum(d.marketCap)}**; EV ${fmtNum(d.enterpriseValue)} (debt ${fmtNum(d.balance.longTermDebt)}, cash & ST inv. ${fmtNum(d.balance.cashAndShortTermInvestments)}).`,
          `TTM through ${d.ttmThrough ?? "–"}: revenue ${fmtNum(d.ttm.revenue)}, EBIT ${fmtNum(d.ttm.ebit)}, net income ${fmtNum(d.ttm.netIncome)}, FCF ${fmtNum(d.ttm.fcf)}.`,
          d.staleWarning ? `\n⚠️ ${d.staleWarning}` : "",
          "",
          mdTable(
            ["P/E", "P/S", "P/FCF", "EV/Revenue", "EV/EBIT", "Earnings yield", "FCF yield"],
            [[fmtNum(d.multiples.pe, "x"), fmtNum(d.multiples.ps, "x"), fmtNum(d.multiples.pFcf, "x"), fmtNum(d.multiples.evRevenue, "x"), fmtNum(d.multiples.evEbit, "x"), fmtNum(d.multiples.earningsYield, "%"), fmtNum(d.multiples.fcfYield, "%")]],
          ),
          "",
          "_Price from Yahoo Finance (unofficial); fundamentals from SEC filings. Multiples are blank when the denominator is negative or missing. Debt = long-term debt only (excludes leases and current portion)._",
        ].join("\n"),
      );
    },
  );
}
