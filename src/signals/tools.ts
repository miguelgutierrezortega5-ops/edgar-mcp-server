import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fmtNum, mdTable, render, responseFormatField } from "../services/format.js";
import { registerReadTool } from "../tools/register.js";
import { getAuctions } from "./auctions.js";
import { BANXICO_DEFAULTS, getBanxicoSeries } from "./banxico.js";
import { filterCalendar, getCalendar } from "./calendar.js";
import { CONTRACTS, getPositioning } from "./cot.js";
import { getEarningsCalendar, getEarningsExpectations } from "./earnings.js";
import { getEffr, getFedFundsFutures, getFomcMeetings, getKalshiSeries, impliedPath } from "./fed.js";
import { getChain, summarizeChain, type ChainSummary } from "./options.js";
import { getFearGreed, kalshiMarkets, searchKalshiSeries, searchPolymarket } from "./sentiment.js";
import { getShortInterest, getShortVolume } from "./shorts.js";
import { inZone, pct, signedPct } from "./stats.js";

const symbolField = z.string().min(1).max(12).describe("US ticker or index, e.g. 'NVDA', 'ASML', 'SPY', 'SPX', 'NDX', 'VIX'.");

/** Risk-free rate for option maths: the latest effective fed funds rate, else 4%. */
async function riskFree(): Promise<number> {
  try {
    return (await getEffr()).rate / 100;
  } catch {
    return 0.04;
  }
}

function chainMarkdown(d: ChainSummary): string {
  const lines = [
    `# ${d.symbol} options — spot ${d.spot.toFixed(2)} (Cboe delayed quote, ${d.asOf} UTC)`,
    "",
    `- **IV30**: ${pct(d.iv30)} · **put/call volume** ${fmtNum(d.putCallVolume, "x")} · **put/call open interest** ${fmtNum(d.putCallOi, "x")}`,
  ];
  if (d.event) {
    const e = d.event;
    lines.push(
      `- **Event ${e.date} (${e.timing.replace("_", " ")})**: first expiry that includes it ${e.postExpiry}, straddle ±${pct(e.postStraddlePct)}; ` +
        `move attributable to the event alone (1σ) ${e.eventSigmaPct !== null ? `±${pct(e.eventSigmaPct)}` : "– (no clean pre-event expiry)"}`,
    );
  }
  const levelHeads = d.expiries[0]?.levels.map((l) => `P(${l.move < 0 ? "≤" : "≥"}${signedPct(l.move, 0)})`) ?? [];
  lines.push(
    "",
    mdTable(
      ["Expiry", "Days", "ATM strike", "Straddle", "Expected move", "Range", "ATM IV", "1σ", "25Δ skew", "P/C OI", ...levelHeads],
      d.expiries.map((x) => [
        x.expiry,
        x.days,
        x.atmStrike,
        x.straddle?.toFixed(2),
        x.movePct !== null ? `±${pct(x.movePct)}` : "–",
        x.movePct !== null ? `${(d.spot * (1 - x.movePct)).toFixed(2)}–${(d.spot * (1 + x.movePct)).toFixed(2)}` : "–",
        pct(x.atmIv),
        x.sigmaMovePct !== null ? `±${pct(x.sigmaMovePct)}` : "–",
        x.skew25 !== null ? `${(x.skew25 * 100).toFixed(1)} pts` : "–",
        fmtNum(x.putCallOi, "x"),
        ...x.levels.map((l) => pct(l.probability, 0)),
      ]),
    ),
    "",
    "_Expected move = ATM straddle ÷ spot. Level probabilities are risk-neutral (Black-Scholes with the smile's IV at each level): the market's price of the outcome, not a forecast. Positive 25Δ skew = puts richer than calls (demand for downside protection)._",
  );
  return lines.join("\n");
}

export function registerSignalTools(server: McpServer): void {
  registerReadTool(
    server,
    "options_get_implied_move",
    {
      title: "Options-implied move and probabilities",
      description: `What the options market prices for a US stock, ETF or index, from Cboe's free delayed chains (15-minute delay):
per expiry, the expected move (ATM straddle ÷ spot) and its price range, ATM implied volatility and the 1σ move, 25-delta skew (puts vs calls), put/call open interest, and the risk-neutral probability of finishing beyond each requested move (e.g. ≤−5%, ≥+10%).
Give event_date (e.g. an earnings date) to isolate the move priced for that event. Use it before forecasting a reaction: it replaces a guess with the market's own distribution.`,
      inputSchema: {
        symbol: symbolField,
        max_expiries: z.number().int().min(1).max(20).default(6).describe("How many expiries to show (default 6)."),
        min_days: z.number().min(0).max(800).default(0).describe("Skip expiries closer than this many days (default 0)."),
        levels: z.array(z.number().min(-90).max(300)).max(8).default([-10, -5, 5, 10]).describe("Moves in percent for the probability columns, e.g. [-10,-5,5,10]."),
        event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Date of a known event such as earnings (YYYY-MM-DD)."),
        event_timing: z.enum(["before_open", "after_close"]).default("after_close").describe("When the event happens relative to the session (default after_close)."),
        response_format: responseFormatField,
      },
    },
    async ({ symbol, max_expiries, min_days, levels, event_date, event_timing, response_format }) => {
      const [chain, rate] = await Promise.all([getChain(symbol), riskFree()]);
      const data = summarizeChain(chain, { now: new Date(), rate, levels: levels.map((l) => l / 100), maxExpiries: max_expiries, minDays: min_days, event: event_date ? { date: event_date, timing: event_timing } : undefined });
      return render(response_format, data, chainMarkdown);
    },
  );

  registerReadTool(
    server,
    "rates_get_fed_probabilities",
    {
      title: "Market-implied Fed decisions",
      description: `Probability of a hike, hold or cut at each upcoming FOMC meeting from two independent markets:
(1) 30-day fed funds futures with the CME FedWatch method (anchored on the New York Fed's latest effective rate and the Fed's own meeting calendar), and (2) Kalshi's regulated Fed-decision contracts.
Use it instead of quoting press reports of "odds"; when the two sources disagree by more than ~10 points, say so.`,
      inputSchema: {
        meetings: z.number().int().min(1).max(10).default(6).describe("Upcoming meetings to show (default 6)."),
        include_kalshi: z.boolean().default(true).describe("Also show Kalshi's Fed-decision markets (default true)."),
        response_format: responseFormatField,
      },
    },
    async ({ meetings, include_kalshi, response_format }) => {
      const today = new Date().toISOString().slice(0, 10);
      const [effr, all, kalshi] = await Promise.all([getEffr(), getFomcMeetings(), include_kalshi ? getKalshiSeries("KXFEDDECISION").catch(() => []) : Promise.resolve([])]);
      const upcoming = all.filter((m) => m.date >= today).slice(0, meetings);
      const futures = await getFedFundsFutures(today.slice(0, 7), 16);
      const path = impliedPath(effr.rate, upcoming, futures);
      const data = { effr, path, kalshi: kalshi.slice(0, meetings), futuresUsed: futures };
      return render(response_format, data, (d) =>
        [
          `# Market-implied Fed path`,
          "",
          `- **Effective fed funds rate** ${d.effr.rate.toFixed(2)}% on ${d.effr.date} (target range ${d.effr.targetFrom.toFixed(2)}–${d.effr.targetTo.toFixed(2)}%)`,
          "",
          "## Fed funds futures (CME FedWatch method)",
          mdTable(
            ["Decision", "Rate before", "Rate after", "Change", "P(cut 50)", "P(cut 25)", "P(hold)", "P(hike 25)", "P(hike 50)", "From"],
            d.path.map((p) => [p.date, `${p.before.toFixed(3)}%`, `${p.after.toFixed(3)}%`, `${p.changeBp >= 0 ? "+" : ""}${p.changeBp.toFixed(1)} bp`, pct(p.probs.cut50, 0), pct(p.probs.cut25, 0), pct(p.probs.hold, 0), pct(p.probs.hike25, 0), pct(p.probs.hike50, 0), p.method === "next_month" ? "next month's contract" : "same month's contract"]),
          ),
          "",
          ...(d.kalshi.length
            ? [
                "## Kalshi Fed-decision markets",
                ...d.kalshi.map((e) => `- **${e.title}** — ${e.outcomes.map((o) => `${o.label} ${pct(o.probability, 0)}`).join(" · ")}`),
                "",
              ]
            : []),
          "_Futures probabilities assume 25 bp steps and chain each meeting from the previous expected rate, so later meetings are cumulative expectations. Kalshi prices are bid/ask mids normalized to 100%._",
        ].join("\n"),
      );
    },
  );

  registerReadTool(
    server,
    "rates_get_treasury_auctions",
    {
      title: "Treasury auction demand",
      description: `Recent US Treasury note and bond auctions (Fiscal Data API): high yield, bid-to-cover, the share primary dealers had to absorb and the share taken by indirect (largely foreign) bidders, each compared with the average of the previous 6 auctions of the same tenor.
Weak demand (low bid-to-cover, high dealer share) pressures long yields and, through them, equity valuations.`,
      inputSchema: {
        limit: z.number().int().min(1).max(40).default(10).describe("Auctions to show, newest first (default 10)."),
        response_format: responseFormatField,
      },
    },
    async ({ limit, response_format }) => {
      const data = await getAuctions(limit);
      return render(response_format, data, (d) =>
        [
          "# Treasury auctions (notes and bonds)",
          "",
          mdTable(
            ["Date", "Tenor", "Reopening", "High yield", "Bid-to-cover", "vs prev. 6", "Dealer share", "vs prev. 6", "Indirect share"],
            d.map((a) => [a.date, a.term, a.reopening ? "yes" : "no", a.highYield !== null ? `${a.highYield.toFixed(3)}%` : "–", a.bidToCover?.toFixed(2), a.prevBidToCover?.toFixed(2), pct(a.dealerShare), pct(a.prevDealerShare), pct(a.indirectShare)]),
          ),
          "",
          "_Source: US Treasury Fiscal Data (auctions_query). Dealer share = primary dealers' accepted ÷ total accepted._",
        ].join("\n"),
      );
    },
  );

  registerReadTool(
    server,
    "calendar_get_economic_events",
    {
      title: "Economic calendar with forecasts",
      description: `This week's (and, once published, next week's) economic releases with the consensus forecast and the previous value (Forex Factory feed): CPI, PPI, payrolls, retail sales, central-bank decisions and speeches.
Countries are currency codes (USD, EUR, GBP, JPY, CAD, CNY…; Mexico is not covered). Times are shown in the requested IANA time zone. Compare an actual print against this forecast before calling it hot or cold.`,
      inputSchema: {
        countries: z.array(z.string().length(3)).default(["USD"]).describe("Currency codes (default ['USD']); [] for all."),
        impacts: z.array(z.enum(["High", "Medium", "Low", "Holiday"])).default(["High", "Medium"]).describe("Impact levels (default High and Medium)."),
        include_next_week: z.boolean().default(true),
        query: z.string().max(60).optional().describe("Filter titles, e.g. 'CPI'."),
        time_zone: z.string().default("America/New_York").describe("IANA time zone for display, e.g. 'America/Los_Angeles', 'America/Mexico_City'."),
        response_format: responseFormatField,
      },
    },
    async ({ countries, impacts, include_next_week, query, time_zone, response_format }) => {
      const events = filterCalendar(await getCalendar(include_next_week), { countries, impacts, query });
      const data = events.map((e) => ({ ...e, local: inZone(e.date, time_zone) }));
      return render(response_format, data, (d) =>
        [
          `# Economic calendar (${time_zone})`,
          "",
          mdTable(["When", "Country", "Event", "Impact", "Forecast", "Previous"], d.map((e) => [e.local, e.country, e.title, e.impact, e.forecast || "–", e.previous || "–"])),
          "",
          "_Source: Forex Factory weekly calendar feed. Forecasts are consensus estimates; actual values are not included in the feed._",
        ].join("\n"),
      );
    },
  );

  registerReadTool(
    server,
    "positioning_get_cot",
    {
      title: "CFTC futures positioning",
      description: `Speculative positioning from the CFTC Commitments of Traders report (weekly, Tuesday data published Friday), ranked against its own history:
leveraged funds and asset managers for stock-index, Treasury, currency (incl. Mexican peso), VIX and Bitcoin futures; non-commercials and commercials for gold, silver, copper and WTI.
Extremes (≤10th or ≥90th percentile) mark crowded trades that unwind violently; a crowded short in index futures can also fuel squeezes.
Contracts: ${Object.keys(CONTRACTS).join(", ")}.`,
      inputSchema: {
        contracts: z.array(z.enum(Object.keys(CONTRACTS) as [string, ...string[]])).default(["sp500", "nasdaq100", "ust10y", "mxn", "vix", "gold"]).describe("Contracts to show."),
        weeks: z.number().int().min(26).max(520).default(156).describe("History window for percentiles, in weeks (default 156 = 3 years)."),
        response_format: responseFormatField,
      },
    },
    async ({ contracts, weeks, response_format }) => {
      const rows = (await Promise.all(contracts.map((c) => getPositioning(c, weeks)))).filter((r): r is NonNullable<typeof r> => r !== null);
      return render(response_format, rows, (d) =>
        [
          `# CFTC positioning (percentiles over ${weeks} weeks)`,
          "",
          mdTable(
            ["Contract", "Report", "Group", "Net contracts", "% of OI", "1w change", "4w change", "Percentile", "z", "Other group", "Net", "Percentile"],
            d.map((p) => [p.name, p.date, p.specLabel, fmtNum(p.specNet), pct(p.specNetPctOi), fmtNum(p.change1w), fmtNum(p.change4w), pct(p.percentile, 0), Number.isFinite(p.z) ? p.z.toFixed(2) : "–", p.otherLabel, fmtNum(p.otherNet), pct(p.otherPercentile, 0)]),
          ),
          "",
          "_Source: CFTC Public Reporting (Traders in Financial Futures and Legacy futures-only reports). Positive net = long._",
        ].join("\n"),
      );
    },
  );

  registerReadTool(
    server,
    "sentiment_get_fear_greed",
    {
      title: "CNN Fear & Greed index",
      description: `CNN's Fear & Greed index (0 = extreme fear, 100 = extreme greed) with its seven components (momentum, 52-week highs vs lows, breadth, put/call, VIX, safe-haven demand, junk-bond demand), the readings a week, a month and a year ago, and today's percentile within the returned history.`,
      inputSchema: { response_format: responseFormatField },
    },
    async ({ response_format }) => {
      const data = await getFearGreed();
      return render(response_format, data, (d) =>
        [
          `# Fear & Greed: ${d.score.toFixed(1)} (${d.rating}) — ${d.asOf}`,
          "",
          `- Previous close ${d.previousClose.toFixed(1)} · 1 week ago ${d.oneWeekAgo.toFixed(1)} · 1 month ago ${d.oneMonthAgo.toFixed(1)} · 1 year ago ${d.oneYearAgo.toFixed(1)}`,
          `- Percentile within the last ${d.historyDays} readings: ${pct(d.percentile, 0)}`,
          "",
          mdTable(["Component", "Measures", "Score", "Rating"], d.components.map((c) => [c.key, c.label, c.score.toFixed(1), c.rating])),
          "",
          "_Source: CNN Business Fear & Greed (unofficial endpoint). Contrarian at extremes; mid-range readings carry little information._",
        ].join("\n"),
      );
    },
  );

  registerReadTool(
    server,
    "sentiment_get_prediction_markets",
    {
      title: "Prediction-market odds",
      description: `Real-money odds for macro and market events from Polymarket (keyword search) and Kalshi (series whose title matches the query, or explicit series tickers such as 'KXFEDDECISION', 'KXRATEHIKE', 'KXINXB' S&P 500 range, 'KXNOTE10M' 10-year yield).
Use English keywords: 'recession', 'Fed', 'CPI', 'S&P 500', 'unemployment', 'tariffs'. Low-volume markets are noisy; check the volume column.`,
      inputSchema: {
        query: z.string().min(2).max(80).describe("Keywords, e.g. 'recession 2026', 'Fed rate', 'CPI'."),
        sources: z.array(z.enum(["polymarket", "kalshi"])).default(["polymarket", "kalshi"]),
        kalshi_series: z.array(z.string().max(40)).max(6).optional().describe("Explicit Kalshi series tickers (skips the title search)."),
        limit: z.number().int().min(1).max(15).default(6).describe("Events per source (default 6)."),
        response_format: responseFormatField,
      },
    },
    async ({ query, sources, kalshi_series, limit, response_format }) => {
      const [poly, kal] = await Promise.all([
        sources.includes("polymarket") ? searchPolymarket(query, limit).catch(() => []) : Promise.resolve([]),
        sources.includes("kalshi")
          ? (kalshi_series?.length ? Promise.resolve(kalshi_series) : searchKalshiSeries(query, 4).then((s) => s.map((x) => x.ticker)))
              .then((series) => kalshiMarkets(series, Math.max(1, Math.ceil(limit / 2))))
              .catch(() => [])
          : Promise.resolve([]),
      ]);
      const data = [...poly, ...kal];
      return render(response_format, data, (d) =>
        [
          `# Prediction markets: "${query}"`,
          "",
          mdTable(
            ["Source", "Market", "Odds", "Volume", "Closes"],
            d.map((m) => [m.source, m.question, m.outcomes.map((o) => `${o.label} ${pct(o.probability, 0)}`).join(" · "), fmtNum(m.volume), m.closes?.slice(0, 10)]),
          ),
          "",
          "_Sources: Polymarket gamma API and Kalshi trade API (public market data). Prices are probabilities implied by trading, not forecasts by the sources._",
        ].join("\n"),
      );
    },
  );

  registerReadTool(
    server,
    "earnings_get_expectations",
    {
      title: "Earnings expectations and priced move",
      description: `Before an earnings report: the next report date and timing, consensus EPS per quarter and year with the high/low range and the number of upward and downward revisions in the last 4 weeks, the last 4 surprises, and (optionally) the move the options market prices for the report.
Source: Nasdaq's public API (Zacks consensus) and Cboe options. US tickers only.`,
      inputSchema: {
        symbol: symbolField,
        include_options: z.boolean().default(true).describe("Add the options-implied earnings move (default true)."),
        response_format: responseFormatField,
      },
    },
    async ({ symbol, include_options, response_format }) => {
      const exp = await getEarningsExpectations(symbol);
      let options: ChainSummary | null = null;
      if (include_options && exp.nextDate) {
        try {
          const [chain, rate] = await Promise.all([getChain(symbol), riskFree()]);
          options = summarizeChain(chain, { now: new Date(), rate, levels: [], maxExpiries: 0, event: { date: exp.nextDate, timing: exp.timing ?? "after_close" } });
        } catch {
          options = null;
        }
      }
      const data = { ...exp, optionsEvent: options?.event ?? null, spot: options?.spot ?? null };
      const rows = (t: typeof exp.quarterly) => t.map((r) => [r.period, r.consensus?.toFixed(2), r.low?.toFixed(2), r.high?.toFixed(2), r.estimates, r.revisionsUp, r.revisionsDown]);
      return render(response_format, data, (d) =>
        [
          `# ${d.symbol} earnings expectations`,
          "",
          `- **Next report**: ${d.nextDate ?? "unknown"}${d.timing ? ` (${d.timing.replace("_", " ")})` : ""}`,
          d.dateText ? `- ${d.dateText}` : "",
          d.optionsEvent
            ? `- **Options price for the report**: straddle of ${d.optionsEvent.postExpiry} ±${pct(d.optionsEvent.postStraddlePct)}; event-only 1σ ${d.optionsEvent.eventSigmaPct !== null ? `±${pct(d.optionsEvent.eventSigmaPct)}` : "–"} (spot ${d.spot?.toFixed(2)})`
            : "",
          "",
          "## Quarterly consensus EPS",
          mdTable(["Quarter", "Consensus", "Low", "High", "Estimates", "Revisions up (4w)", "Revisions down (4w)"], rows(d.quarterly)),
          "",
          "## Yearly consensus EPS",
          mdTable(["Fiscal year", "Consensus", "Low", "High", "Estimates", "Revisions up (4w)", "Revisions down (4w)"], rows(d.yearly)),
          "",
          "## Recent surprises",
          mdTable(["Quarter", "Reported", "EPS", "Consensus", "Surprise"], d.surprises.map((s) => [s.quarter, s.reported, s.eps?.toFixed(2), s.consensus?.toFixed(2), signedPct(s.surprisePct)])),
          "",
          "_Consensus: Zacks via Nasdaq. Beating consensus is the norm (about 3 in 4 S&P 500 companies do); the reaction depends on guidance and the size of the beat versus the move already priced._",
        ]
          .filter((l) => l !== "")
          .join("\n"),
      );
    },
  );

  registerReadTool(
    server,
    "earnings_get_calendar",
    {
      title: "Earnings calendar",
      description: `Companies reporting on a date with timing (before open / after close), consensus EPS, number of estimates and last year's EPS (Nasdaq public API, US listings), largest first.`,
      inputSchema: {
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Report date (YYYY-MM-DD)."),
        min_market_cap_billions: z.number().min(0).default(10).describe("Only companies at least this large, in USD billions (default 10)."),
        response_format: responseFormatField,
      },
    },
    async ({ date, min_market_cap_billions, response_format }) => {
      const rows = (await getEarningsCalendar(date)).filter((r) => (r.marketCap ?? 0) >= min_market_cap_billions * 1e9).sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0));
      return render(response_format, rows, (d) =>
        [
          `# Earnings on ${date} (market cap ≥ $${min_market_cap_billions}B)`,
          "",
          mdTable(["Symbol", "Company", "Market cap", "When", "Quarter", "EPS forecast", "Estimates", "Last year EPS"], d.map((r) => [r.symbol, r.name, fmtNum(r.marketCap), r.timing, r.quarter, r.epsForecast?.toFixed(2), r.estimates, r.lastYearEps?.toFixed(2)])),
        ].join("\n"),
      );
    },
  );

  registerReadTool(
    server,
    "stocks_get_short_interest",
    {
      title: "Short interest and daily short volume",
      description: `Short positioning for a US stock: exchange-reported short interest with days to cover (twice a month) and FINRA's daily short-sale volume ratio for the last N trading days.
Daily short volume includes market-maker hedging (~40–50% is normal), so compare the ratio with the stock's own average rather than reading it as bearish conviction.`,
      inputSchema: {
        symbol: symbolField,
        days: z.number().int().min(1).max(20).default(10).describe("Trading days of FINRA short volume (default 10)."),
        response_format: responseFormatField,
      },
    },
    async ({ symbol, days, response_format }) => {
      const [interest, volume] = await Promise.all([getShortInterest(symbol), getShortVolume(symbol, days)]);
      const avg = volume.length ? volume.reduce((a, v) => a + v.ratio, 0) / volume.length : null;
      const data = { symbol: symbol.toUpperCase(), shortInterest: interest.slice(0, 8), dailyShortVolume: volume, averageRatio: avg };
      return render(response_format, data, (d) =>
        [
          `# ${d.symbol} short positioning`,
          "",
          "## Short interest",
          mdTable(["Settlement", "Shares short", "Avg daily volume", "Days to cover"], d.shortInterest.map((r) => [r.settlement, fmtNum(r.shares), fmtNum(r.avgDailyVolume), r.daysToCover?.toFixed(2)])),
          "",
          `## FINRA daily short volume (average ratio ${pct(d.averageRatio)})`,
          mdTable(["Date", "Short volume", "Total volume", "Ratio"], d.dailyShortVolume.map((v) => [v.date, fmtNum(v.shortVolume), fmtNum(v.totalVolume), pct(v.ratio)])),
        ].join("\n"),
      );
    },
  );

  registerReadTool(
    server,
    "mexico_get_banxico_series",
    {
      title: "Banco de México series",
      description: `Series from Banco de México's SIE API: by default the FIX USD/MXN rate (SF43718) and Banxico's target rate (SF61745); any SIE series id works.
Needs a free token in the BANXICO_TOKEN environment variable (https://www.banxico.org.mx/SieAPIRest/service/v1/token). Without dates it returns the latest value.`,
      inputSchema: {
        series_ids: z.array(z.string().regex(/^S[A-Z]\d+$/)).min(1).max(10).default(Object.keys(BANXICO_DEFAULTS)).describe("SIE series ids, e.g. ['SF43718','SF61745']."),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        response_format: responseFormatField,
      },
    },
    async ({ series_ids, start_date, end_date, response_format }) => {
      const data = await getBanxicoSeries(series_ids, start_date, end_date);
      return render(response_format, data, (d) =>
        d
          .map((s) =>
            [`## ${s.title} (${s.id})`, mdTable(["Date", "Value"], s.points.slice(-30).map((p) => [p.date, p.value ?? "–"]))].join("\n"),
          )
          .join("\n\n"),
      );
    },
  );
}
