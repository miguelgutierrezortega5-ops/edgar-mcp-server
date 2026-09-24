# DCF method (free cash flow to equity holders, simplified)

Use code to compute the DCF and show every assumption.

## Inputs

| Input | Source | Notes |
| --- | --- | --- |
| Base FCF | `edgar_get_key_metrics`: TTM or last-FY free cash flow | Consider subtracting SBC (`sbc_pct_revenue` × revenue) for a conservative view; say which you used. |
| Growth, years 1–5 | Revenue and FCF history, plus guidance from the MD&A or earnings release | Fade toward the terminal rate; avoid more than 25% a year unless justified. |
| Growth, years 6–10 | Linear fade from the year-5 rate to the terminal rate | |
| Terminal growth `g` | 2–3% | Must be below the discount rate. |
| Discount rate `r` | Risk-free rate (10y from `market_get_treasury_yields`) + equity risk premium (about 4.5–5.5%) × beta (assume 1.0 unless known) | Typical range is 8–11% for large caps. |
| Net cash | Cash + short-term investments − long-term debt | From `edgar_get_key_metrics` (`net_cash`). |
| Shares | `market_get_valuation` (`sharesOutstanding`) | |

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

1. The assumptions table.
2. The projected FCF by year.
3. PV of the explicit period vs PV of the terminal value. If the terminal value is more than 75% of the total, flag it.
4. A sensitivity grid: `r` ∈ {base − 1%, base, base + 1%} × `g` ∈ {2%, 2.5%, 3%}.
5. The reverse DCF: the growth rate implied by today's price. It is often more informative than the point estimate.
6. The caveats: the result depends heavily on the assumptions, and it is not investment advice.
