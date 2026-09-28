---
name: sec-financial-analysis
description: Fundamental, market and macro analysis of US and European stocks. Uses the edgar-mcp-server tools (SEC filings, XBRL financials, Form 4, 13F, prices, dividends, Treasury, FRED, World Bank) plus any connected financial connectors (Fiscal.ai, FMP, Alpha Vantage, TipRanks, EODHD) in quota-aware order. Use it whenever the user wants to analyze, compare or value a company (multiples or DCF), review earnings, a call transcript or a 10-K/10-Q/8-K, check insiders, fund holdings or analyst views, study dividends, technicals or options, screen stocks, review the economy, or gauge how other regions (China, Japan, UK, Switzerland, emerging markets, oil) spill over into US and EU markets. Also triggers on Spanish requests such as "analiza la empresa", "compara", "valoración", "resultados", "insiders", "cartera de Buffett", "dividendos", "inflación", "tipos de interés", "bolsa europea", "mercados internacionales".
---

# Financial analysis: SEC data plus market connectors

This skill covers company and market research with the `edgar_*`, `market_*` and `macro_*` tools of edgar-mcp-server, plus the financial connectors the user has connected. Route each question to the cheapest reliable source, cross-check the numbers that matter, and always cite the source and the period end date of every figure.

## Investor focus: US and EU first, the rest of the world as a secondary driver

- **Primary markets: the United States and the European Union.** Put the depth of the analysis there: companies, sectors, rates, inflation, currencies and indices.
- **Everything else is a secondary driver.** That includes non-EU Europe (UK, Switzerland, Norway), China and Hong Kong, Japan, Korea and Taiwan, India, Canada, Latin America and the Gulf and OPEC+. It deserves a short **"Global spillovers"** section whenever one of the exposure channels is material for the company or market being analyzed. Keep it proportional: a few bullets, not the headline. When a company is listed in the UK or Switzerland, analyze it like an EU company; those markets weigh heavily in European indices.
- The channels, what to check for each region, and the verified tickers and FRED series are in `references/global-spillovers.md`. Read it when writing that section or when the user asks about international markets.

## Sources, routing and quotas

Tool names depend on the client: `mcp__FMP__quote` in Claude Code, `quote` under the FMP connector in claude.ai. Match them by connector and tool name. If a connector isn't connected, skip it and use the next source; if nothing covers a need, say so rather than guessing.

| Tier | Sources | How to use them |
| --- | --- | --- |
| 1: free or no tight quota | edgar-mcp-server (`edgar_*`, `market_*`, `macro_*`); **Fiscal.ai** | Default for fundamentals, filings, prices, macro, segments, transcripts, insiders and 13F |
| 2: metered daily | **FMP** (free plan: US symbols only); **Alpha Vantage** (free key: about 25 calls a day) | US quotes, analyst consensus, calendars, country risk premium; technicals, options, news sentiment |
| 3: scarce | **TipRanks** (basic plan: 10 calls a month); **EODHD** (free plan: end-of-day prices only, 20 calls a day) | Only for what nobody else has, one batched call at a time |

Rules that save quota:
- Spend tier 3 only when the user asks for what only it has (TipRanks: Smart Score, AI score, analyst track records, crowd and hedge-fund sentiment, "why is it moving today"). Batch every ticker into one call (`get_assets_data` and `get_ai_stock_analysis` accept a list). `get_my_usage` (TipRanks) and `get_user_details` (EODHD) are free and show what's left.
- Never spend a metered call to re-confirm a number a tier-1 source already gave. Compute simple indicators (returns, volatility, SMA, RSI, drawdown, correlation) yourself from `market_get_stock_price` history instead of calling an API.
- If the user says they upgraded a plan, relax these limits accordingly.
- When sources disagree, prefer the filing (SEC via `edgar_*`, or Fiscal.ai as-reported data) and mention the gap.

The full routing matrix, the verified plan limits and each connector's key calls are in `references/connectors.md`. Read it before the first call to a connector you haven't used in the conversation, especially Fiscal.ai, whose calls go through a JavaScript sandbox.

## Ground rules

- **Identify the company and its listing first.**
  - US tickers work directly in `edgar_*`; if a name is ambiguous, call `edgar_search_companies`. The SEC covers US-listed companies plus foreign issuers that file 20-F or 40-F.
  - For EU and other non-SEC companies, use Fiscal.ai. Its company keys look like `EXCHANGE_TICKER`, e.g. `BMEX_ITX`, `XPAR_MC`, `XSWX_NESN`. Dual-listed European companies are often keyed by their US line (`NYSE_SAP`, `NASDAQ_ASML`, `NYSE_SAN`), so check `countryCode`.
  - For prices, use the Yahoo symbol with its exchange suffix in `market_get_stock_price`: `.MC` Madrid, `.PA` Paris, `.DE` Xetra, `.AS` Amsterdam, `.MI` Milan, `.SW` Zurich, `.L` London.
- **State the periods.** Every number needs its fiscal period. Fiscal years differ (MSFT ends in June, AAPL in September). Many EU companies report half-years (H1/H2) with Q1 and Q3 trading updates; use Fiscal.ai `periodType: "semi-annual"` for those.
- **State the currency.** EU companies report in EUR, GBP, CHF, SEK or DKK. Never mix currencies in one table. Fiscal.ai's `currency` parameter converts; say when you converted (the response includes `appliedExchangeRate`).
- **US GAAP vs IFRS.** When comparing US and European peers, flag the differences that move ratios: IFRS 16 puts nearly all leases on the balance sheet (higher EBITDA and debt), and development costs can be capitalized under IFRS.
- **Watch freshness and caveats.** If `market_get_valuation` shows a ⚠️ warning, mention it. If it refuses (ADR in another currency, no current share count), use Fiscal.ai `company_ratios` or `edgar_get_key_metrics` plus `market_get_stock_price` instead. The newest quarter is often in the earnings release (8-K item 2.02, or Fiscal.ai `company_filings` "Earnings Press Release") before it reaches XBRL.
- **Per-share caveat.** EPS and share counts are as reported and may not be split-adjusted across years. For ADRs, Fiscal.ai reports per-ADS values and gives the ordinary-share conversion.
- **No investment advice.** Present the evidence, the bull and bear points, and the key uncertainties. Do not tell the user to buy or sell.
- Answer in the user's language.

## Workflow 1: Company deep-dive

1. **Profile.** US: `edgar_get_company_info`. EU or other: Fiscal.ai `company_profile`.
2. **Metrics.** US: `edgar_get_key_metrics`, annual with 5 periods, then quarterly for momentum. Any company: Fiscal.ai `company_financials_standardized` and `company_ratios`.
3. **Segments and geography.** Fiscal.ai `company_segments_and_kpis` gives business and geographic revenue plus company KPIs. The geographic split feeds the spillover check.
4. **Filing text.** US: `edgar_read_filing` with `section` set to `business`, `risk_factors` and `mdna`; summarize the 5–8 most company-specific risks. EU: Fiscal.ai `company_filings`; read a specific page with `filing_page_image` only when needed.
5. **Valuation.** US: `market_get_valuation`. Any company: Fiscal.ai `company_ratios`, and `company_daily_ratios` for the company's own history. Add `market_get_stock_price` (1y).
6. **Insiders.** US: `edgar_get_insider_trades` with `open_market_only: true`. Otherwise use Fiscal.ai `company_insider_transactions`; coverage outside North America is limited, so say so.
7. **Street view** (optional, metered). US: FMP `analyst` (`price-target-consensus`, `grades-summary`). EU, or when the user wants analyst track records: TipRanks `get_assets_data`, batched.
8. **Investor theses.** Fiscal.ai `company_fund_letters` shows what professional investors write about the company.
9. **News.** Fiscal.ai `company_news_summary`. Use TipRanks `get_stock_catalyst` only when the user asks why the stock is moving today.
10. **Global spillovers.** Add this only if a channel is material; see `references/global-spillovers.md`.

Output structure:
- **Summary**: 3–4 sentences.
- **Business**: what it sells, to whom, and how it makes money.
- **Financial trajectory**: a table of revenue, margins, FCF and ROE over the years, with commentary.
- **Balance sheet**: net cash or debt, liquidity.
- **Valuation**: multiples vs the company's own history and its peers.
- **Street view**: consensus target, rating mix and fund-letter stance (if fetched).
- **Risks**: the specific ones.
- **Insider activity**
- **Global spillovers (secondary)**: only if material.
- **What to watch**: upcoming catalysts and open questions.

## Workflow 2: Peer comparison

1. Choose 3–6 real competitors. Fiscal.ai `company_peers` returns ranked peers across countries, which is useful for US-vs-EU comparisons. For US-only sets, check the SIC code in `edgar_get_company_info`.
2. For all-SEC sets, use `edgar_compare_companies`. For mixed US/EU sets, use Fiscal.ai `company_financials_standardized` and `company_ratios` with the same `currency` for everyone.
3. Explain *why* the metrics differ, such as business mix, scale, capital intensity or accounting (GAAP vs IFRS), not just which is higher.

## Workflow 3: Valuation

**Multiples.** Use `market_get_valuation` (US) or Fiscal.ai `company_ratios` (any), then compare with peers (Workflow 2) and with the company's own growth and margins. A high P/E needs high, durable growth or ROE.

**DCF.** Use this when the user asks for intrinsic value. See `references/dcf.md` for the method, the inputs for USD and EUR companies, and the country risk premium; compute it with code. Always show the assumptions table and a sensitivity grid, and treat the result as a range. FMP `discountedCashFlow` (`dcf-advanced`) is a black-box cross-check only: show it for reference and explain why it differs.

## Workflow 4: Earnings review (latest quarter or half-year)

1. **Release.**
   - US: `edgar_list_filings` with forms `["8-K"]` and item `2.02`, then `edgar_read_filing` on the press-release exhibit (often `…ex99_1.htm`) passed as `document`.
   - EU: Fiscal.ai `company_filings` → "Earnings Press Release".
2. **Call transcript.** Fiscal.ai `company_ir_events` gives the transcript rows; then call `company_ir_events_transcript` with the `eventKey`. Summarize guidance, tone, and the analysts' toughest questions in the Q&A. Alpha Vantage `EARNINGS_CALL_TRANSCRIPT` is a metered fallback.
3. **Actual vs expected.** Fiscal.ai `company_earnings_summary`, FMP `calendar` (`earnings-company`) for US symbols, and Alpha Vantage `EARNINGS` for the surprise history.
4. **Trend.** Quarterly `edgar_get_financial_statement` and `edgar_get_key_metrics`, or Fiscal.ai quarterly or semi-annual standardized data, compared with the prior-year period.
5. **Summary.** Growth, margin changes, cash flow, guidance, and anything unusual (one-offs, segment shifts, buyback pace).

## Workflow 5: Insider activity

- `edgar_get_insider_trades` with a `max_filings` of 20–40, or Fiscal.ai `company_insider_transactions`.
- Open-market **buys (P)** are the meaningful signal, especially clustered buys by several insiders.
- Sales under 10b5-1 plans and tax-withholding (F) transactions are mostly noise; say so.
- Report net open-market $ bought vs sold, who traded, and whether the trades were plan-based.

## Workflow 6: Screening and idea generation

- **US, on one reported figure.** `edgar_rank_companies` ranks every filer on one XBRL concept for a calendar period (e.g. `us-gaap:Revenues` for `CY2025`). Sanity-check outliers with `edgar_get_key_metrics`, since they are often tagging errors.
- **Any country or sector.** Filter Fiscal.ai `companies_list` in code by `countryCode` or `sector`, then pull `company_ratios` for a shortlist, at most six calls at a time.
- **Ideas by country** (scarce). TipRanks `get_top_smart_score_stocks` with `country` (Germany, Spain, France, UK…) and `sector`.
- The FMP screener is not available on the free plan.

## Workflow 7: Thematic research

- `edgar_full_text_search` with exact phrases in quotes, e.g. `"GLP-1"`, `"export controls"` or `"going concern"`, filtered by form and date. Then read the passages with `edgar_read_filing` and `find`.
- For global and non-SEC coverage, use Fiscal.ai `top_news` with an `eventType` filter (e.g. `regulatory`, `ma`, `guidance`) and `fund_letters` for what investors are writing about.

## Workflow 8: Fund and investor portfolios (13F)

- A fund's portfolio: `edgar_get_institutional_holdings` with the manager's name or CIK, or Fiscal.ai `holder_institutional_holdings`.
- Who owns a stock: Fiscal.ai `company_institutional_holders`.
- Report concentration (top 10 share), the biggest new positions and additions, and exits. Changes are in shares held, so price moves don't count as buying or selling.
- Caveats: 13F is filed up to 45 days after quarter end and covers long US-listed positions only (no shorts, cash, bonds or foreign shares). PUT/CALL rows show the value of the underlying shares, not the option premium.

## Workflow 9: Dividends

- `market_get_dividends` works for US and European symbols (e.g. `SAN.MC`): TTM yield, payments per year, 5/10-year CAGR, consecutive increases, and splits.
- Check sustainability against free cash flow and EPS with `edgar_get_key_metrics` (US) or Fiscal.ai standardized cash flow (any). A payout above ~80% of FCF, or dividends funded with debt, deserves a warning.
- Many European companies pay once or twice a year and vary the amount with earnings, so a lower year is not always a cut. Withholding tax on foreign dividends depends on the paying country and the investor's residence; mention it, but don't quote rates without checking them.

## Workflow 10: Macro backdrop

- **US** (FRED via `macro_get_series`):
  - rates: `FEDFUNDS`, `DGS2`, `DGS10`, `T10Y2Y`;
  - inflation: `CPIAUCSL`, `PCEPILFE` with `transform: "pct_change_yoy"`;
  - jobs: `UNRATE`, `PAYEMS`, `ICSA`;
  - growth: `A191RL1Q225SBEA`;
  - credit and risk: `BAMLH0A0HYM2`, `VIXCLS`;
  - recession: `SAHMREALTIME`.
- **Euro area** (FRED):
  - `ECBDFR`: ECB deposit rate;
  - `CP0000EZ19M086NEST`: HICP index, with `pct_change_yoy`;
  - `CLVMNACSCAB1GQEA19`: real GDP;
  - `IRLTLT01DEM156N` and `IRLTLT01ITM156N`: German and Italian 10-year yields. The Italy − Germany spread is the euro-area stress gauge.
  - `DEXUSEU`: USD per euro.
  - Indices: `^STOXX50E`, `^STOXX`, `^GDAXI`, `^FCHI`, `^IBEX`, `FTSEMIB.MI` via `market_get_stock_price`.
- **Calendars.** For earnings dates, use Fiscal.ai `events_calendar` (filter by `country`) or FMP `calendar`. For economic data releases, FMP's `economics-calendar` needs a paid plan: use a web search, or TipRanks `get_economic_calendar` (scarce).
- **Rest of the world** is the secondary layer: see `references/global-spillovers.md`. Use `macro_get_country_indicator` (World Bank) for annual structural data on any country.
- **Tie macro to the holding:** rate sensitivity (debt, housing, banks), FX exposure of foreign revenue, and input costs (energy, metals).

## Workflow 11: Technicals, options and sentiment (only on request)

- **Trend and risk.** Compute returns, volatility, moving averages, RSI, drawdown and correlations in code from `market_get_stock_price` history; this is free. Use Alpha Vantage indicators (`RSI`, `MACD`, `BBANDS`…) only for something not easily computed.
- **Options.** Alpha Vantage `HISTORICAL_OPTIONS` and put/call ratio tools (metered). TipRanks `get_options_unusual_trades` is scarce.
- **Sentiment.** Alpha Vantage `NEWS_SENTIMENT`. Crowd, blogger and hedge-fund positioning comes from TipRanks (scarce, batched).
- Present technicals as context for the fundamentals, not as trading signals.

## Workflow 12: Portfolio, watchlist and follow-up

- **Holdings.** The user's portfolios can come from TipRanks (`list_my_portfolios`, `get_portfolio_holdings`) or Fiscal.ai (`terminal_list_portfolios`, `terminal_get_portfolio`). Summarize exposure by region, sector and currency, then run the spillover check at portfolio level.
- **Memory.** Save a watchlist, a thesis or a preference to a memory connector (Mem0 or Vertiso Memory) only when the user asks or agrees, and recall it at the start of related requests.
- **Delivery.** Google Drive, Gmail and Calendar are available on request: save a report, draft an email, add earnings dates to the calendar. Always confirm before sending an email or creating an event.

## Useful XBRL concepts beyond the standard statements

Search with `edgar_search_concepts`; tags vary by company.
- Backlog or remaining performance obligations: `RevenueRemainingPerformanceObligation`
- Deferred revenue: `ContractWithCustomerLiabilityCurrent`
- Shares outstanding (cover page): `dei:EntityCommonStockSharesOutstanding`
- Dividends per share: `CommonStockDividendsPerShareDeclared`
- Operating lease liabilities: `OperatingLeaseLiability`
- Segment revenue is usually dimensional and **not** in the XBRL dataset. Use Fiscal.ai `company_segments_and_kpis`, or read the 10-K segment note with `edgar_read_filing` and `find: "segment information"`.
