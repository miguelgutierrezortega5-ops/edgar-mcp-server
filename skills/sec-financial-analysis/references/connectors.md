# Connectors: what each one is for, and in what order

The limits below were measured in September 2026 on free or basic plans. Other users may have different plans: if a call is refused for plan reasons, don't retry it or its sibling endpoints; use the next source and tell the user which plan would unlock it.

## Routing matrix

| Need | 1st choice (free) | Then (metered) | Last resort (scarce) |
| --- | --- | --- | --- |
| US fundamentals, statements, metrics | `edgar_get_key_metrics`, `edgar_get_financial_statement` | Fiscal.ai standardized; FMP `statements` (`key-metrics-ttm`, `income-statement`…) | — |
| EU and other non-SEC fundamentals | Fiscal.ai `company_financials_standardized`, `company_ratios` | — | — |
| Segments, geographic revenue, company KPIs | Fiscal.ai `company_segments_and_kpis` | TipRanks `get_company_kpis` | — |
| Filings and their text | `edgar_read_filing`, `edgar_full_text_search` (US) | Fiscal.ai `company_filings`, `filing_page_image` (EU) | — |
| Earnings call transcripts | Fiscal.ai `company_ir_events` → `company_ir_events_transcript` | Alpha Vantage `EARNINGS_CALL_TRANSCRIPT` | TipRanks `get_earnings_call_summary` |
| Prices: US, EU, indices, FX, futures | `market_get_stock_price` (Yahoo symbols) | FMP `quote` / `chart` (US stocks only), `indexes` → `index-quote` (world indices: `^GSPC`, `^STOXX50E`, `^N225`, `^HSI`…), `forex`, `commodity`; Alpha Vantage `GLOBAL_QUOTE` | EODHD `get_historical_stock_prices` (EOD) |
| Dividends | `market_get_dividends` | FMP `calendar` (`dividends-company`); Alpha Vantage `DIVIDENDS` | TipRanks `get_dividend_history` |
| Valuation multiples | `market_get_valuation` (US); Fiscal.ai `company_ratios`, `company_daily_ratios` | FMP `key-metrics-ttm`, `enterprise-values` | — |
| Analyst consensus and price targets | — | FMP `analyst` (`price-target-consensus`, `grades-summary`, US); Alpha Vantage `EARNINGS_ESTIMATES` | TipRanks `get_assets_data` (batch), `get_recent_analyst_ratings` |
| Earnings dates and results vs estimates | Fiscal.ai `events_calendar`, `company_earnings_summary` | FMP `calendar` (`earnings-calendar`, `earnings-company`); Alpha Vantage `EARNINGS`, `EARNINGS_CALENDAR` | TipRanks `get_earnings_calendar` |
| Insiders | `edgar_get_insider_trades`; Fiscal.ai `company_insider_transactions` | FMP `insiderTrades` | TipRanks `get_insider_transactions` |
| 13F: fund portfolios and holders of a stock | `edgar_get_institutional_holdings`; Fiscal.ai `holder_institutional_holdings`, `company_institutional_holders` | — (FMP 13F needs Ultimate) | TipRanks `get_hedge_fund_activity` |
| What investors write | Fiscal.ai `company_fund_letters`, `fund_letters` | — | TipRanks `get_blogger_sentiment` |
| News | Fiscal.ai `company_news_summary`, `company_news`, `top_news` | FMP `news`; Alpha Vantage `NEWS_SENTIMENT` | TipRanks `get_stock_catalyst`, `get_assets_news` |
| US macro | `macro_get_series` (FRED), `market_get_treasury_yields` | Alpha Vantage `TREASURY_YIELD`, `FEDERAL_FUNDS_RATE`, `CPI`, `UNEMPLOYMENT`… | — |
| Economic data calendar | Web search | — (FMP `economics-calendar` needs Starter) | TipRanks `get_economic_calendar` |
| EU and world macro | `macro_get_series` (FRED international IDs), `macro_get_country_indicator` (World Bank) | — | — |
| Country risk and equity risk premium | — | FMP `economics` (`market-risk-premium`, every country) | EODHD credit tools (paid plan only) |
| Commodities | `macro_get_series` (`DCOILBRENTEU`, `PCOPPUSDM`…); `market_get_stock_price` (`BZ=F`, `HG=F`, `TTF=F`) | Alpha Vantage `BRENT`, `WTI`, `COPPER`, `NATURAL_GAS`…; FMP `commodity` | TipRanks `get_commodity_quote` |
| Technical indicators | Compute from `market_get_stock_price` history | Alpha Vantage (`RSI`, `MACD`, `BBANDS`, `SMA`…) | TipRanks `get_technical_analysis` |
| Options | — | Alpha Vantage `HISTORICAL_OPTIONS`, put/call ratio | TipRanks options tools |
| Congress trades | — | FMP `senate` (`senate-trading`, `house-trading`); Alpha Vantage `CONGRESS_TRADES` | TipRanks `get_politician_activity` |
| Screening | `edgar_rank_companies` (US XBRL); Fiscal.ai `companies_list` filtered in code | — (the FMP screener needs Starter) | TipRanks `get_top_smart_score_stocks` (by country) |
| Smart Score, AI score, crowd sentiment | — | — | TipRanks (`get_assets_data`, `get_ai_stock_analysis`, `get_investor_sentiment`) |
| User's portfolios | Fiscal.ai `terminal_list_portfolios`, `terminal_get_portfolio` | — | TipRanks `list_my_portfolios`, `get_portfolio_holdings` |
| On-chain crypto | Blockscout (call `__unlock_blockchain_analysis__` once per session first) | — | — |

## edgar-mcp-server (tier 1)

- The source of truth for SEC data: XBRL financials, filings text, Form 4, 13F and full-text search. It also serves Yahoo prices (any global symbol), dividends, the Treasury curve, FRED series and World Bank indicators.
- `macro_get_series` downloads **any** FRED ID, even without a FRED key. The key only widens `macro_search_series`.
- It only exists where the user installed it (Claude Desktop, Claude Code, or this repo's HTTP mode). On claude.ai without it, use Fiscal.ai for fundamentals, filings, insiders and 13F, and FMP or Alpha Vantage for prices and macro.

## Fiscal.ai (tier 1)

- No per-call quota was observed on the maintainer's plan, but it is a paid service; don't loop over hundreds of companies without need.
- It works through `execute_code`: plain JavaScript in the exact form `async () => { ... }`, calling `codemode.<helper>(...)`, with at most **6 concurrent calls**, a 60-second limit, and one compact `console.log(JSON.stringify(result))`. Reduce large payloads inside the sandbox before logging.
- Call `api_docs` **with a `functions` list** (e.g. `["company_segments_and_kpis"]`) to get a signature. The full reference is about 86k characters, so don't request it whole.
- **Company keys.** `EXCHANGE_TICKER`: `NASDAQ_MSFT`, `NYSE_JPM`, `BMEX_ITX` (Inditex), `XPAR_MC` (LVMH), `XSWX_NESN` (Nestlé), `XMEX_WALMEX`. Dual-listed firms may use the US line (`NYSE_SAP`, `NASDAQ_ASML`, `NYSE_SAN`). To resolve a name, filter `companies_list` (about 12,000 companies, 12 pages of 1,000) in code.
- **Coverage.** Strong for the US, Canada and Europe (GB, SE, PL, FR, DE, IT, ES, CH, NL…), much thinner for Japan, Mexico and emerging Asia.
- **Key helpers:**
  - financials: `company_financials_standardized` / `_as_reported` (`periodType`: annual, quarterly, ltm, semi-annual; `currency`), `company_ratios`, `company_daily_ratios`;
  - business detail: `company_segments_and_kpis`, `company_peers`;
  - filings and calls: `company_filings`, `company_ir_events`, `company_ir_events_transcript`;
  - ownership: `company_insider_transactions`, `company_institutional_holders`, `holder_institutional_holdings`;
  - investors and news: `company_fund_letters`, `fund_letters`, `company_news_summary`, `top_news`;
  - calendar and portfolios: `events_calendar`, `terminal_*` portfolios.
- **Citations.** Link sources with the `auditUrl` in each `sources` entry, and company pages with the `terminalUrl` from `company_profile`. Never construct fiscal.ai URLs by hand, and never use `api.fiscal.ai` URLs, which need a key.

## FMP (tier 2; free plan)

- **Works:**
  - `quote` for US symbols;
  - `statements` (incl. `key-metrics-ttm`, `metrics-ratios-ttm`, `revenue-geographic-segments`);
  - `analyst` (`price-target-consensus`, `grades-summary`, `financial-estimates`);
  - `indexes` → `index-quote` for world indices (`^GSPC`, `^STOXX50E`, `^N225`, `^HSI`), `forex` (`EURUSD`…), `commodity` (`BZUSD` Brent…);
  - `calendar`, `economics` → `market-risk-premium`;
  - `discountedCashFlow`, `news`, `insiderTrades`, `senate`, `company`.
- **Refused on this plan:** non-US stocks (e.g. `ITX.MC`), yield indices (`^TNX`), `economics-calendar`, `search` (screener and name search), `technicalIndicators`, `earningsTranscript`, `form13F`, `ESG`, `commitmentOfTraders` and `tipranks`.
- **Quirks:**
  - `financial-estimates` lists the furthest fiscal year first. Request several with `limit` and pick the years you need.
  - `revenue-geographic-segments` is often coarse (e.g. "US / Non US"); Fiscal.ai segments are usually finer.
  - `market-risk-premium` returns every country in one call.

## Alpha Vantage (tier 2; free key)

- The free key is usually capped at about 25 calls a day; treat every call as valuable. `datatype: "json"` returns JSON instead of CSV.
- **Best for:** technical indicators, options (`HISTORICAL_OPTIONS`, put/call ratios), `NEWS_SENTIMENT`, `EARNINGS` (surprises), `EARNINGS_ESTIMATES`, `EARNINGS_CALL_TRANSCRIPT`, commodities, and `ANALYTICS_FIXED_WINDOW` (correlation and variance across up to 5 symbols).
- Realtime entitlements and bulk quotes are premium.

## TipRanks (tier 3; basic plan: 10 calls a month)

- **Unique:**
  - scores: Smart Score (1–10) and the AI Stock Analysis score (0–100, six models);
  - analysts: ratings with each analyst's track record, and bull/bear key points;
  - positioning: crowd and blogger sentiment, hedge-fund activity;
  - events: catalysts ("why it moved today"), unusual options, the FDA calendar, buybacks;
  - the user's TipRanks portfolios.
- Call `get_my_usage` first (it's free). Batch tickers: `get_assets_data` takes a whole watchlist, and `get_ai_stock_analysis` takes up to 25 tickers. Every call counts, even a failed one.
- Present its content as information, not recommendations; the market commentary is AI-generated.

## EODHD (tier 3; free plan)

- Only end-of-day prices, 20 calls a day. `get_historical_stock_prices` with `TICKER.EXCHANGE`, e.g. `ITX.MC`, `AAPL.US`.
- Everything else refuses on the free plan with 403 ("Only EOD data allowed for free users"): fundamentals, credit (sovereign CDS, country risk premium), policy rates, options and news. Use it only if Yahoo via `market_get_stock_price` fails.

## Memory, documents and delivery

- **Mem0 / Vertiso Memory.** Durable memory across sessions (watchlists, theses, preferences). Write only with the user's consent, as one idea per memory.
- **Google Drive, Gmail and Calendar.** Save reports, draft emails, add earnings dates. Confirm before sending or creating anything.
