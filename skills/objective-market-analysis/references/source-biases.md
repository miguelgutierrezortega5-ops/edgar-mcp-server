# Source biases and how to correct them

Each source below has a known, persistent tilt. The correction is to show the data the source provides, labelled for what it is, and never to let the source's framing become the conclusion.

## Sell-side ratings and price targets

- **The tilt.**
  - Ratings skew to Buy. For S&P 500 stocks, FactSet's tallies usually show about half Buy, around 40% Hold and well under 10% Sell.
  - The bottom-up 12-month target for the index typically implies roughly +10% at almost any point in the cycle, including just before bear markets (2008, 2022).
  - Targets are revised after the price moves, so they lag.
- **Why.** Investment-banking relationships, access to management, and career risk: a lone Sell that is wrong costs more than a Buy that is wrong alongside the consensus.
- **Correction.**
  - Report the rating mix and target dispersion as crowd sentiment.
  - Where useful, report how far the price would have to move to reach the low target.
  - Never write "X% of potential" as an expectation.

## Company guidance and "beats"

- **The tilt.** Companies guide conservatively so they can beat. About three quarters of S&P 500 companies beat EPS consensus in a typical quarter (FactSet Earnings Insight). TSMC beat the top of its own revenue guidance in Q4 2025 ($33.7 bn vs $32.2–33.4 bn) and Q3 2026 ($46.7 bn vs $44.6–45.8 bn).
- **Correction.**
  - The informative comparison is results vs the most demanding credible consensus, plus the size of the beat vs the stock's typical beat.
  - The stock's reaction depends on guidance vs the buy-side "whisper", which is usually above published consensus.
  - Name the consensus source, because they differ.

## Press explanations

- **The tilt.** After a move, the press attaches a single cause. On down days several stories compete, and the one that gets repeated sounds certain.
- **Correction.**
  - Label these "explicación citada por la prensa".
  - Keep them separate from measured facts (yields, flows, data surprises).
  - Do not use one as evidence for a forecast.

## Short and selected samples

- **The tilt.** Post-2009 data come from one regime: falling rates, quantitative easing and a bull market. Rebound statistics from that window are rosier than the full history.
- **Correction.**
  - Show both windows.
  - Flag the adverse one.
  - Report the number of non-overlapping episodes.

## Survivorship in holdings and watchlists

- **The tilt.** People hold and watch stocks that went up. Their historical drift (NVDA, MU, ASML) is not a forecast. Simulations on raw history inherit it.
- **Correction.** Use drift-free simulations ("sin deriva ⚠ref" in `riskstats.py --portfolio`) as the forward reference.

## Mean-reversion and "oversold" claims

- **The tilt.** RSI below 30 or a big drawdown sounds like an opportunity. In trending declines (2000–02, 2008, 2022) oversold readings persisted for months.
- **Correction.**
  - Report the conditional forward distribution for that state, including the intermediate drawdown, from `riskstats.py`.
  - Do not use the label alone.

## The assistant's own tilt

- **The tilt.** Assistants are trained to be agreeable and reassuring, so they drift toward the comforting reading, soften bad news and end on a positive note.
- **Correction.** Follow this skill's procedure, the tone audit and the forecast log. The log reveals a persistent tilt in either direction once a few forecasts have resolved.
