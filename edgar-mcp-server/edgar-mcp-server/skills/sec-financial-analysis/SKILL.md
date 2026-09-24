---
name: sec-financial-analysis
description: Fundamental equity analysis of US-listed companies using the edgar-mcp-server tools (SEC EDGAR filings and XBRL financials, Form 4 insider trades, Treasury yields, stock prices). Use when the user asks to analyze a stock or company, compare competitors, value a company (multiples or DCF), review earnings or a 10-K/10-Q/8-K, check insider buying/selling, or screen companies on a financial metric. Also triggers on Spanish requests such as "analiza la empresa", "compara", "valoración", "resultados trimestrales", "insiders".
---

# SEC financial analysis

Workflows for company research with the `edgar_*` and `market_*` MCP tools. All data is free and public. Always cite the period end dates and sources you used.

## Ground rules

- **Identify the company first.** Tickers work directly; if ambiguous, call `edgar_search_companies`. Coverage is SEC filers only (US-listed companies plus foreign issuers filing 20-F/40-F). For others, say so instead of guessing.
- **State the periods.** Every number needs its fiscal period (column headers are period end dates). Fiscal years differ between companies (e.g. MSFT ends June, AAPL September, NVDA January).
- **Watch data freshness.** If `market_get_valuation` shows a ⚠️ staleness warning, mention it. For the newest quarter, the 8-K item 2.02 press release (`edgar_list_filings` with forms `["8-K"]`) is often ahead of XBRL data.
- **Per-share caveat.** EPS and share counts are as reported and may not be split-adjusted across years. Check `edgar_get_concept` for splits or compare with share counts before computing per-share growth across a split.
- **No investment advice.** Present the evidence, the bull and bear points, and the key uncertainties. Do not tell the user to buy or sell.
- Answer in the user's language.

## Workflow 1: Company deep-dive

1. `edgar_get_company_info`: what the company is, its fiscal year end, and its latest reports.
2. `edgar_get_key_metrics` (annual, 5 periods), then quarterly with 5 periods for momentum.
3. `edgar_get_financial_statement`: go deeper where the metrics raise questions, e.g. rising receivables, capex surge or debt.
4. `edgar_read_filing` with `section: "business"`: skim the business model and segments.
5. `edgar_read_filing` with `section: "risk_factors"`: summarize the 5–8 most company-specific risks and skip boilerplate.
6. `edgar_read_filing` with `section: "mdna"`: management's explanation of the drivers.
7. `market_get_valuation` plus `market_get_stock_price` (1y).
8. `edgar_get_insider_trades` with `open_market_only: true`.

Output structure:
- **Summary**: 3–4 sentences.
- **Business**: what it sells, to whom, and how it makes money.
- **Financial trajectory**: a table of revenue, margins, FCF and ROE over the years, plus commentary.
- **Balance sheet**: net cash or debt, liquidity.
- **Valuation**: multiples vs the company's own history or its peers.
- **Risks**: the specific ones.
- **Insider activity**
- **What to watch**: upcoming catalysts and open questions.

## Workflow 2: Peer comparison

1. Choose 3–6 real competitors. Check `edgar_get_company_info` for the SIC code if unsure.
2. `edgar_compare_companies` with every peer.
3. `market_get_valuation` for each company to compare multiples.
4. Explain *why* the metrics differ, such as business mix, scale or capital intensity, not just which is higher.

## Workflow 3: Valuation

**Multiples.** Use `market_get_valuation`. For context, compare with peers (Workflow 2) and with the company's own growth and margins. A high P/E needs high, durable growth or ROE.

**DCF.** Use this when the user asks for intrinsic value. See `references/dcf.md` for the method, and compute it with code rather than mentally.
- Inputs: TTM or last-FY free cash flow from `edgar_get_key_metrics`, net cash from the same table, shares from `market_get_valuation`, and the risk-free rate from the 10-year yield in `market_get_treasury_yields`.
- Always show the assumptions table and a sensitivity grid (discount rate × terminal growth).
- Treat the result as a range, not a point estimate.

## Workflow 4: Earnings review (latest quarter)

1. `edgar_list_filings` with forms `["8-K"]`: find the latest filing with item `2.02`.
2. `edgar_read_filing` on that accession number. The main document of an earnings 8-K is usually just a cover page; the header lists the filing's other documents. Read the press release exhibit (often named `…ex99_1.htm` or `…ex991.htm`) by passing it as `document`. It has the headline numbers and guidance.
3. `edgar_get_financial_statement` (quarterly) and `edgar_get_key_metrics` (quarterly): trend vs the prior year's quarter.
4. Summarize: growth, margin changes, cash flow, guidance, and anything unusual such as one-offs, segment shifts or buyback pace.

## Workflow 5: Insider activity

- `edgar_get_insider_trades` with a `max_filings` of 20–40.
- Open-market **buys (P)** are the meaningful signal, especially clustered buys by several insiders.
- Sales under 10b5-1 plans and tax-withholding (F) transactions are mostly noise; say so.
- Report net open-market $ bought vs sold, who traded, and whether the trades were plan-based.

## Workflow 6: Screening and ranking

- `edgar_rank_companies` ranks every filer on one XBRL concept for a calendar period, e.g. `us-gaap:Revenues` for `CY2025`, or `us-gaap:CashAndCashEquivalentsAtCarryingValue` for `CY2025Q4I`.
- Extreme outliers are often tagging errors in the filing. Sanity-check the top results with `edgar_get_key_metrics` before presenting them.

## Workflow 7: Thematic research

- Use `edgar_full_text_search` with exact phrases in quotes, e.g. `"GLP-1"`, `"export controls"` or `"going concern"`. Filter by form and date.
- Use it to find which companies mention a theme, then read the relevant passages with `edgar_read_filing` and `find`.

## Useful XBRL concepts beyond the standard statements

Search with `edgar_search_concepts`; tags vary by company.
- Backlog or remaining performance obligations: `RevenueRemainingPerformanceObligation`
- Deferred revenue: `ContractWithCustomerLiabilityCurrent`
- Shares outstanding (cover page): `dei:EntityCommonStockSharesOutstanding`
- Dividends per share: `CommonStockDividendsPerShareDeclared`
- Operating lease liabilities: `OperatingLeaseLiability`
- Segment revenue is usually dimensional and **not** in this dataset. Read it from the 10-K segment note with `edgar_read_filing` and `find: "segment information"`.
