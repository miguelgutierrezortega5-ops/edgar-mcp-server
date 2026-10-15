# Fear and herding as numbers

## Reading rule

Compare each gauge with its own 10-year history:
- **≤10th or ≥90th percentile:** extremes, which carry information.
- **20th–80th percentile:** mostly noise. Call it "neutral (percentil N)".
- **Disagreement between gauges** (e.g. a calm VIX with a very high SKEW) is information in itself. Report it.

Where possible, attach the forward distribution that followed similar readings. `riskstats.py --market` does this for the VIX.

## Market gauges

| Gauge | Source | What it measures | Reading and caveats |
|---|---|---|---|
| VIX | `^VIX` (Yahoo) | 30-day implied volatility of the S&P 500 | Level and percentile. Spikes mark fear; low levels mark complacency, not safety. |
| VIX / VIX3M | `^VIX`, `^VIX3M` | Shape of the volatility term structure | Above 1 means acute short-term stress (about 8% of days in 10 years). It often coincides with capitulation lows and with the worst days. |
| VIX9D | `^VIX9D` | 9-day implied volatility | Above the VIX means stress is centred on the next few days (events, data). |
| VXN | `^VXN` | Implied volatility of the Nasdaq 100 | Relevant for tech-heavy portfolios. |
| VVIX | `^VVIX` | Volatility of the VIX | High means demand for protection against volatility spikes. |
| SKEW | `^SKEW` | Price of far out-of-the-money puts | High means demand for crash protection. Mixed predictive record. Most useful when it disagrees with a calm VIX. |
| MOVE | `^MOVE` | Implied volatility of Treasuries | Rising MOVE pressures equity multiples, especially long-duration growth stocks. |
| HYG/LQD | `HYG`, `LQD` | High-yield vs investment-grade credit | A falling ratio means credit stress. It uses total-return prices, so the level drifts up over time: read the 21-day change, not the percentile. |
| RSP/SPY | `RSP`, `SPY` | Equal-weight vs cap-weight S&P 500 | Low means gains are concentrated in a few megacaps (herding into leaders). This fragility shows up in the correlation of sell-offs. |
| Correlation | `riskstats.py --market` | Average pairwise correlation of the user's symbols, 20 days vs 1 year | Rising correlation means assets move as one block, so diversification is failing when needed. |
| Breadth of the list | `riskstats.py --market` | Symbols below their 50-day average | A rough breadth gauge for the user's universe. |
| Streaks and capitulation | `riskstats.py` streak rows | Consecutive down days, and their forward statistics | Report the conditional outcome. Do not assume a long streak must end. |
| Put/call ratio | Alpha Vantage `REALTIME_PUT_CALL_RATIO` / `HISTORICAL_PUT_CALL_RATIO` | Options hedging demand per symbol | Metered (25 a day). Extremes only. |
| AAII bull–bear spread | Web (weekly) | Retail investor sentiment | Contrarian at extremes. Weekly and noisy. |
| CNN Fear & Greed | Web | Composite of 7 gauges | Overlaps with the gauges above. Quote it only as a summary. |
| Analyst rating mix and target dispersion | TipRanks `get_assets_data`, FMP `grades-summary` | Consensus crowding | Near-unanimous Buy is crowding, not confirmation. |
| Short interest, days to cover | Web, FINRA | Bearish positioning | High short interest adds squeeze risk and signals bearish conviction. |
| Fund flows, margin debt | Web (ICI, EPFR, FINRA monthly) | Retail and leveraged participation | Record margin debt raises the size of forced selling in a drawdown. |
| Insider open-market buying | `edgar_get_insider_trades` | Informed buyers | Clusters of buys are the signal. Sales are mostly noise. |

## The user's own behavioural numbers

- **Loss aversion.** Losses weigh about 2.25× an equal gain (Tversky & Kahneman, 1992).
  - Translate a scenario's MXN loss next to its MXN gain so the asymmetry is visible.
  - Do not use it to soften the loss.
- **Concentration and correlation.**
  - Give the share of the account in each correlated block (e.g. tech and semiconductors).
  - Give the MXN impact of a 10% move in that block.
- **Recency and herding.** Buying after large gains (MU +375% in a year) and selling after sharp drops are measurable. Show the state that a planned buy or sell comes from, using `riskstats.py` conditional rows.
- **Disposition effect.** People tend to sell winners early and hold losers. When the user plans a sale, report both positions' conditional statistics, not just the one they mention.
