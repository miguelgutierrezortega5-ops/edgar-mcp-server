import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { companyField, resolveCompany, tickersForCik } from "../services/companies.js";
import { getSubmissions, recentFilings } from "../services/filings.js";
import { fmtNum, mdTable, render, responseFormatField } from "../services/format.js";
import { httpGet } from "../services/http.js";
import { getYieldCurve } from "../services/treasury.js";
import { computeValuation } from "../services/valuation.js";
import { getCompanyFacts } from "../services/xbrl.js";
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
      const row = await getYieldCurve(date);
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
market cap, enterprise value, P/E, P/S, P/FCF, EV/Revenue, EV/EBIT, earnings yield and FCF yield. TTM = sum of the last 4 consecutive quarters, or the latest fiscal year when quarters are missing (e.g. 20-F filers).
Fails with an explanation when the company reports in a different currency from its share price (ADRs such as TSM or NVO).`,
      inputSchema: { company: companyField, response_format: responseFormatField },
    },
    async ({ company, response_format }) => {
      const reg = await resolveCompany(company);
      if (!reg.ticker) throw new Error(`No ticker known for ${reg.name}; valuation needs a listed share price.`);
      const [facts, chart, submissions, tickers] = await Promise.all([getCompanyFacts(reg.cik), getChart(reg.ticker, "5d", "1d"), getSubmissions(reg.cik), tickersForCik(reg.cik)]);
      const price = chart[0].meta.regularMarketPrice;
      if (price === undefined) throw new Error(`No current price for ${reg.ticker}.`);
      const latestReport = recentFilings(submissions).find((f) => /^(10-Q|10-K|20-F|40-F)$/.test(f.form));
      const data = computeValuation({ facts, ticker: reg.ticker, price, priceCurrency: chart[0].meta.currency, tickers, latestReport });
      return render(response_format, data, (d) =>
        [
          `# ${d.company} (${d.ticker}) — valuation`,
          "",
          `Price ${d.price} ${d.currency ?? ""} × ${fmtNum(d.sharesOutstanding)} shares = **market cap ${fmtNum(d.marketCap)}**; EV ${fmtNum(d.enterpriseValue)} (debt ${fmtNum(d.balance.longTermDebt)}, cash & ST inv. ${fmtNum(d.balance.cashAndShortTermInvestments)}${d.balance.asOf ? ` as of ${d.balance.asOf}` : ""}).`,
          `Shares: ${d.sharesBasis}.`,
          `Fundamentals (${d.basis}) through ${d.ttmThrough ?? "–"}: revenue ${fmtNum(d.ttm.revenue)}, EBIT ${fmtNum(d.ttm.ebit)}, net income ${fmtNum(d.ttm.netIncome)}, FCF ${fmtNum(d.ttm.fcf)}.`,
          ...d.warnings.map((w) => `\n⚠️ ${w}`),
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
