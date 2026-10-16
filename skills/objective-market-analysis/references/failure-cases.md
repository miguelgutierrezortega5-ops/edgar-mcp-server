# Failure cases (October 2026)

These are real errors from the conversation that produced this skill. Four of them made the picture look better than the data; one went the other way, too pessimistic. The point is calibration, not pessimism.

## 1. The user's hypothesis was answered with reasons it would not happen

- **What happened.** Before the week of 12 October the user said semiconductors could correct on Monday. The analysis led with why a decline was not likely. By Thursday the SOX was down 7.9% for the week, with seven sessions down in a row; ASML was −6.9% and NVDA −5.3%.
- **What the data said.**
  - Running `riskstats.py ^SOX` on 15 October showed that after streaks of 7 or more down days, the SOX was lower 5 days later in 71% of cases (15 independent episodes, full history).
  - After 5-day drops as large as this one, P5 over 5 days was −11.4%.
- **Correct handling.**
  - Make the user's hypothesis event #1.
  - Report its base rate, conditional rates and the flagged adverse sample before any counter-argument.

## 2. Earnings reaction estimated against the softer consensus

- **What happened.** ASML's third-quarter reaction was estimated at +4% to +9%. The comparison used Alpha Vantage's consensus (revenue €11.66 bn, Q4 €14.0 bn) instead of LSEG's (€11.72 bn, €14.2 bn). The US shares closed −3.9%.
- **Correct handling.**
  - Use the most demanding credible consensus and name it.
  - Give a symmetric distribution of earnings-day moves from the stock's own history (past reactions, average absolute move, share of up days), not a one-sided range.
  - Log the range with its stated coverage.
  - Read the priced move first: `options_get_implied_move` with `event_date`. For LLY's 29 October report the options priced a ±7.9% straddle (±7.2% from the event alone) on 16 October.

## 3. An inflation surprise reported with the milder measure

- **What happened.** The September PPI was reported as core +0.5% vs a +0.4% forecast. That was the measure excluding food, energy and trade. The measure markets trade, excluding food and energy, was +0.7% vs +0.3% expected: the largest rise in four years. The headline was also framed as "driven by energy" before the core figure was given.
- **Correct handling.**
  - Lead with the market's measure vs consensus, then the others.
  - Attribute to energy only after the core number is shown to be benign.
  - Take the consensus from `calendar_get_economic_events`. For this release it listed core PPI at 0.3% and headline PPI at 0.6%; my search had not found one.

## 4. "History favours a rebound" from a benign sample

- **What happened.** After the SOX fell 4.3% on 14 October, the answer said history favoured a rebound within 1–2 weeks. That was 63% of cases, using data since 2010.
- **What else the data said.**
  - The full history (with 2000–02 and 2008) gave a next-day rebound rate of 54%, and in a quarter of cases a further drop of 9% within 10 days.
  - The streak sample (case 1) pointed the other way.
- **Correct handling.**
  - Show every sample with its independent n.
  - Flag the adverse one.
  - Report the intermediate drawdown next to any rebound rate.
  - Ban "la historia favorece" without a number and its sample.

## 5. Analyst targets used as anchors

- **What happened.** An "entry point" analysis quoted consensus price targets: MU +77%, GS +25%, LLY +13%.
- **Why it's wrong.** Targets are structurally optimistic and lag price (see source-biases.md).
- **Correct handling.**
  - Present targets as crowd-sentiment data in the herding panel.
  - Never present them as an expected return.

## 6. The opposite error: too pessimistic

- **What happened.** At midnight on 15 October the estimate for the portfolio at the open was −1,200 to −2,000 MXN, based on futures and the Asian sell-off. The day closed at about −60 MXN after an intraday reversal.
- **Lesson.** Point estimates from overnight futures ignore the session's spread of outcomes.
- **Correct handling.** Give the distribution, e.g. the portfolio's 1-day P5/median/P95 from `riskstats.py --portfolio … --horizons 1`, centred on the futures-implied move.

## 7. Fed odds taken from press wording

- **What happened.** After the September CPI, the answer quoted a Reuters sentence ("~49% chance") whose wording was ambiguous between holding and hiking.
- **Correct handling.** Read `rates_get_fed_probabilities`, which gives two independent markets. On 16 October, fed funds futures priced 28% and Kalshi 29% for a hike on 28 October. Report both, and never relay press-reported odds.
