# DCF method (free cash flow to equity holders, simplified)

Use code to compute the DCF and show every assumption. Discount cash flows in the currency the company reports in, with that currency's risk-free rate.

## Inputs

| Input | Source | Notes |
| --- | --- | --- |
| Base FCF | US: `edgar_get_key_metrics` (TTM or last-FY free cash flow). Any company: Fiscal.ai `company_financials_standardized`, cash-flow statement with `periodType: "ltm"` (operating cash flow − capex) | For a conservative view, consider subtracting SBC (`sbc_pct_revenue` × revenue); say which you used. |
| Growth, years 1–5 | Revenue and FCF history, plus guidance from the MD&A, the earnings release or the call transcript (Fiscal.ai `company_ir_events_transcript`) | Fade toward the terminal rate; avoid more than 25% a year unless justified. FMP `analyst` → `financial-estimates` (US) shows what the consensus expects; use it as a reference, not as the input. |
| Growth, years 6–10 | Linear fade from the year-5 rate to the terminal rate | |
| Terminal growth `g` | 2–3% (USD, EUR); lower for low-inflation currencies such as CHF | Must be below the discount rate. |
| Risk-free rate | USD: the 10-year yield from `market_get_treasury_yields`. EUR: the German 10-year (`IRLTLT01DEM156N`). GBP: `IRLTLT01GBM156N`. JPY: `IRLTLT01JPM156N` | FRED international yields are monthly averages and lag a month or two; say so. |
| Equity risk premium | FMP `economics` → `market-risk-premium`: `totalEquityRiskPremium` of the country where the company **operates** (about 4.2–4.5% for the US and Germany) | For companies with large emerging-market revenue, add a revenue-weighted `countryRiskPremium` (e.g. 30% of sales in Mexico × 2.5% CRP ≈ +0.75%). Without FMP, use 4.5–5.5%. |
| Discount rate `r` | Risk-free + beta × ERP (+ weighted CRP) | Assume beta 1.0 unless known. Typical range is 8–11% for large caps. |
| Net cash | Cash + short-term investments − debt: `edgar_get_key_metrics` (`net_cash`) or the Fiscal.ai balance sheet | Under IFRS 16, lease liabilities sit in debt. Be consistent with how FCF treats lease payments. |
| Shares | `market_get_valuation` (`sharesOutstanding`) or Fiscal.ai `company_shares_outstanding` | For ADRs, use the ADS count with an ADS price, or ordinary shares with the local price. Never mix them. |

## Computation

```
FCF_t = FCF_0 × Π(1 + growth_i)                  for t = 1..10
PV    = Σ FCF_t / (1 + r)^t
TV    = FCF_10 × (1 + g) / (r − g)
PV_TV = TV / (1 + r)^10
Equity value    = PV + PV_TV + net cash
Value per share = Equity value / shares
Upside          = Value per share / current price − 1
```

## Always report

1. The assumptions table, with the source of each input.
2. The projected FCF by year.
3. PV of the explicit period vs PV of the terminal value. If the terminal value is more than 75% of the total, flag it.
4. A sensitivity grid: `r` ∈ {base − 1%, base, base + 1%} × `g` ∈ {2%, 2.5%, 3%}.
5. The reverse DCF: the growth rate implied by today's price. It is often more informative than the point estimate.
6. **Cross-checks, as reference only.**
   - FMP `discountedCashFlow` → `dcf-advanced` is a black-box model; show its value and explain why yours differs.
   - FMP `analyst` → `price-target-consensus` shows where analysts are.
7. The caveats: the result depends heavily on the assumptions, and it is not investment advice.
