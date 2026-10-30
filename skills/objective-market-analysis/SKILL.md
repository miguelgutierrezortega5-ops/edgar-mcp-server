---
name: objective-market-analysis
description: Cold, de-biased processing for any judgement about markets, stocks or a portfolio. Numbers come before narrative, the bearish case is tested as hard as the bullish one, base rates and tail risk are computed from long price history, fear and herding are measured as data, known source biases (analyst targets, company guidance, after-the-fact news stories) are corrected, and every forecast is logged and scored. Use it together with sec-financial-analysis whenever an answer will contain a probability, forecast, scenario, outlook, entry or exit level, reaction to earnings or economic data, or a view on whether something will rise or fall. Always use it when the user floats a hypothesis or asks for advice, e.g. "puede haber una caída", "¿seguirá bajando?", "¿es buen punto de entrada?", "panorama de la semana", "asesórame", "¿qué tan probable…?", "revisa cómo va el mercado". Also use it when the user asks for objectivity, less optimism or less compassion.
---

# Objective market analysis

The user wants a computer's reading of the market, not a companion's. This skill is the reasoning and reporting layer. The data layer is sec-financial-analysis (edgar-mcp-server tools and connectors).

## Why this exists

An assistant's default drifts toward reassurance:
- it agrees with the most comforting reading;
- it explains bad data away;
- it leads with the rebound case;
- it anchors on optimistic sources.

With this user, in October 2026, that produced concrete errors (see `references/failure-cases.md`):
- A rebound framing based on a benign sample, while the adverse sample said the opposite.
- An earnings-reaction range of +4% to +9% that came out at −3.9%.
- An inflation surprise reported with the milder measure.

Every one of those errors made the picture look better than the data.

The cure is not pessimism, which is just another bias. The goal is **symmetry and calibration**: if the data say a 35% chance of a 5% drop, say 35%, no softer and no louder.

Human factors are in scope, but as data:
- fear (implied volatility, demand for crash protection);
- herding (correlation, concentration, crowded consensus);
- the user's own loss aversion and concentration.

They appear as numbers, never as a reason to change the tone.

## Procedure

Run these steps in order for any forward-looking question. Steps 2–5 are computational: do them with the scripts, not from memory or impression.

### 1. Turn the question into testable events

Rewrite the question as events with a horizon and a threshold. For example:
- "SOX cae ≥3% en 5 días hábiles".
- "La cartera pierde >2,000 MXN en 21 días".

When the user proposes a hypothesis ("el lunes los semiconductores pueden corregir"), that hypothesis is event #1. Test it first and on its own merits. The failure mode to avoid is explaining why something probably won't happen before counting how often it did happen.

### 2. Base rates and conditional rates

```bash
python3 scripts/riskstats.py ^SOX NVDA ASML --horizons 1,5,10,21 --market
```

For each symbol and horizon it prints:
- an unconditional row;
- rows conditioned on today's state: distance from the 52-week high, the 5-day move, a large daily move, and the current up or down streak.

Each row is shown for the full history and for the last 10 years. It flags with ⚠ the most adverse credible sample, meaning one with at least 10 independent episodes. Use these flags as follows:
- **The flagged rows are the downside reference.** You may argue that another row is more relevant, but the adverse row has to appear in the answer.
- **Put the number of independent episodes next to every probability.** Below ~10, say so in numbers ("15 episodios"), not with "pocos datos".
- **Never rely on a post-2009 sample alone.** It is one regime of falling rates and central-bank support; it excludes 2000–02 and 2008.

Without network or Python (e.g. claude.ai):
- fetch closes with `market_get_stock_price`;
- save them as a `date,close` CSV and run with `--csv SYM=file.csv`;
- with no code runtime, compute at least P(down), P5 and the worst intermediate point from the price table.

### 2b. What markets already price (market-signals-mcp)

Historical frequencies say what happened in similar states. Markets say what is being paid for today. Put both in the same table: the gap between them is information.

- **Price horizon.** Use `options_get_implied_move` and take the expiry nearest the horizon.
  - It gives the expected move (ATM straddle) and the risk-neutral P(≤−5%) and P(≥+5%).
  - Risk-neutral odds slightly overstate downside, because they include a risk premium. Call them "probabilidad que paga el mercado", not a forecast.
  - **Implied above historical:** the market is paying for an event or for fear.
  - **Implied below historical:** complacency.
- **Earnings.** Use `earnings_get_expectations`. It gives the priced move (options with `event_date`), the consensus with up/down revisions in the last 4 weeks, and recent surprises.
  - Compare the priced move with the stock's historical average move on earnings day.
  - Never give a one-sided range.
- **Economic data.** Get the consensus from `calendar_get_economic_events` before the release. Judge the print against that consensus, using the measure the market trades.
- **Fed.** Use `rates_get_fed_probabilities`. It has two independent sources: fed funds futures and Kalshi. Quote both when they differ by more than ~10 points. Never quote press-reported odds.
- **Feeds into step 5:**
  - `positioning_get_cot`: crowded futures positioning, as percentiles.
  - `sentiment_get_fear_greed`: the 7 components.
  - `sentiment_get_prediction_markets`: recession, Fed, S&P ranges.
  - `stocks_get_short_interest`.

### 2c. Company news, dates and a second consensus (Fiscal.ai)

The company news layer comes from Fiscal.ai, not from web search alone. Run it in every portfolio or market update, in one `execute_code` call (at most 6 helpers at once):
- `company_news_summary` for each holding or bellwether that moved ≥2% or reports within 10 days.
- `events_calendar` with the holdings' tickers and the next 6 weeks. It gives the date, whether it is confirmed or estimated, and the session (`before_open` / `after_close`).
- `company_estimates` for the next report that moves the portfolio. Compare its consensus with `earnings_get_expectations` (Zacks) and use the more demanding one (step 7). Name the source field (`agentic_consensus`, `guidance_adjusted`).
- **Cross-check before quoting.** The summaries are machine-written and can be wrong: on 16 October the NVDA summary reported a "$16.1 billion" quarterly revenue and a beat, a month before NVDA's report date. Quote a figure from a summary only when a second source (filing, press release, web) matches it; otherwise drop it.
- Web search stays for market-wide stories (indices, Asia, credit) and for anything newer than the summary's `generatedAt`.

### 2d. Contagion from other companies and rotation (spillover.py)

A holding often moves on another company's news: Intel's guidance, a peer's report, a hyperscaler's capex. Money also leaves tech for defensives and comes back. Measure both before explaining a move.

```bash
python3 scripts/spillover.py map --holdings ASML,KO,JNJ --bellwethers NVDA,TSM,AMD,INTC,LRCX,KLAC,AMAT,VST,MCD,PEP,COST --values ASML=30000,KO=10000,JNJ=10000
python3 scripts/spillover.py rotation --symbols KO,JNJ,VRTX --start 2026-09-30 --reports KO=2026-10-27,JNJ=2026-10-13 --sector KO=XLP,JNJ=XLV
python3 scripts/spillover.py refuge --candidates XLP,XLV,XLU,XLE,GLD,TLT,JNJ,PG,WMT,MXN=X
```

- **`map`** (run it when the portfolio changes):
  - It gives, for each holding, the companies whose own news moved it over 5 years. A news day is a move left after the market, the sector and semiconductors.
  - It also gives the portfolio's MXN impact per −10% of each company.
  - Only links of at least 3 standard errors are shown, and a link must hold without the company's single most extreme day.
- **The type of news decides the contagion.** Company-specific news (share loss, execution) stays with the company. An industry message (demand, capex, PC or AI spending) moves the whole sector, whoever says it.
  - In 14 Intel drops on its own news from 2021 to 2026, ASML moved +0.2% on average.
  - On 30 October 2026, Intel's PC-demand guidance took ASML down 6.6% with the SOX at −7.2%.
  - Say which kind each event is.
- **Calendar.** In every update, list the linked companies that report in the next 3 weeks (step 2c), with the event move the options price (step 2b) times the portfolio's sensitivity, in MXN.
- **`rotation` before attributing a gain to a report.** It splits a holding's return over a window into its own report days, tech-down days, tech-up days and the rest, and compares its correlation with ^SOX with its normal level.
  - Gains made on tech-down days, with a correlation in the bottom percentiles, are rotation, not fundamentals.
  - Rotation gains can be given back when tech rebounds; show the tech-up days column.
- **`refuge` when the user asks where to move.**
  - Report what a refuge does on the shock day, which is usually a smaller fall rather than a rise.
  - Report how often it beat QQQ over the next 63 days, and its P5: refuges cut the tail but have not won more often.
  - Use the regime row that matches today (^SOX above or below its 200-day average) and cash as the zero-risk reference.
  - Never present a refuge as safe because it rose this month: check its correlation with tech in the same window (gold fell with tech in October 2026).

### 3. Tails and path, not just the center

Never report a hit rate or a median alone. "Subió en 63% de los casos" always travels with:
- "antes cayó una mediana de X% (P25: Y%)";
- the P5;
- the CVaR (the average of the worst 5% of outcomes).

People act on the path: they sell at the intermediate low. So the worst intermediate point matters for the decision.

### 4. Translate to the user's portfolio

```bash
python3 scripts/riskstats.py --portfolio "ASML=1,NVDA=4,GOOG=3" --fx MXN=X --cash 24300 --horizons 5,21
```

Use the **"sin deriva ⚠ref"** row as the forward reference. It removes the past drift of the holdings, which are held precisely because they went up (survivorship); the rows with drift flatter the future.
- Express results in the user's currency, including FX.
- Give the recovery asymmetry: −20% needs +25% to get back.
- Young ETFs are extended with an equivalent older fund (QQQM→QQQ, GLDM→GLD). Say so when it matters.

### 5. Fear and herding as numbers

The `--market` panel gives:
- VIX, and VIX/VIX3M (above 1 means acute short-term stress);
- VXN, VVIX, SKEW and MOVE;
- HYG/LQD (credit) and RSP/SPY (equal weight vs cap weight, i.e. concentration);
- the S&P 500's 21-day forward distribution at today's VIX level;
- the average correlation among the symbols, and breadth.

Add these from connectors or the web when relevant:
- put/call ratios (Alpha Vantage);
- AAII sentiment and CNN Fear & Greed;
- the analyst rating mix (consensus crowding);
- short interest and fund flows.

Every indicator gets a value and a historical percentile. Words like "miedo" or "euforia" are only labels for an extreme percentile. Mid-range readings carry little information: say "neutral (percentil 46)" and move on. `references/behavioral-metrics.md` explains each gauge and how to read divergences, e.g. a calm VIX next to a very high SKEW.

The user's behaviour is data as well:
- loss aversion: losses weigh about 2× gains;
- concentration;
- correlation among holdings;
- recent buys and sells.

State them numerically when they bear on the decision, e.g. "53% de la cuenta en tecnología: −10% en ese bloque = −7,300 MXN".

### 6. Evidence ledger

Build two columns with equal effort: "a favor de la caída" and "a favor de la subida" (or for and against the user's hypothesis).
- Each line has a number and a source.
- When the question is about risk or a decline, the downside column comes first.
- Never turn a bad item into a good one inside the same sentence ("…, pero…"). Each item stays in its column.

### 7. Correct source biases

Details and evidence are in `references/source-biases.md`.
- **Analyst price targets and ratings** are crowd-sentiment data, not expected returns. Never present a target's upside as what the stock should do.
- **Company guidance** is set to be beaten.
  - Compare results with consensus first, and say which consensus (LSEG, FactSet and Alpha Vantage differ).
  - Use the most demanding credible one.
  - Beating guidance is the norm, not news.
- **Economic releases:** report first the measure the market trades, vs consensus (e.g. CPI and PPI excluding food and energy, month over month). Don't call a release "inflated by energy" until the core number has been reported and is in fact benign.
- **Press explanations of a move** are after-the-fact stories. Label them "explicación citada por la prensa", separate from the data.
- **Your own earlier estimates** are anchors to check, not positions to defend.

### 8. Scenarios that add up to 100%

Give bear, base and bull scenarios, each with:
- a probability;
- a magnitude and the MXN impact;
- the trigger that would confirm it.

Derive the probabilities from steps 2–5 and show the link, e.g. "P(≤−5%) en la muestra adversa = 18% → escenario bajista 20%".

### 9. What would prove it wrong

List concrete price levels or data releases that would invalidate the estimate, and how much the probabilities would shift.

### 10. Log and score

```bash
python3 scripts/forecast_log.py --log calibration/forecasts.jsonl add --kind prob --symbol ^SOX --horizon 5 --op le --threshold -0.03 --prob 0.35 --claim "SOX cae ≥3% en 5 días"
python3 scripts/forecast_log.py --log calibration/forecasts.jsonl resolve
python3 scripts/forecast_log.py --log calibration/forecasts.jsonl score
```

- Log every probability or range you give: `prob` for an event, `range` for an interval. The log is what detects drift toward optimism or pessimism over time.
- Run `resolve` and `score` at the start of each new market session with the user.
- When a resolved forecast missed, open the answer with it: "Mi estimación anterior (+4% a +9%) falló: resultado −3.9%."
- Once there are resolved probability forecasts, quote the Brier score (0 = perfect, 0.25 = always saying 50%).
- In the edgar-mcp-server repo the log lives at `calibration/forecasts.jsonl`. Commit it so it survives the session. Elsewhere, use any writable path.

## Writing rules

- **Lead with numbers.** The first line answers the question: a probability, a range, an MXN impact, and the horizon.
- **No softeners.** That means no "solo", "apenas", "afortunadamente", "por suerte", "no te preocupes", "lo bueno es que" or "tranquilo".
- **No likelihood word without a number.** That covers "probable", "podría", "suele" and "la historia favorece". They change how a number feels, not what it says.
- **No consolation after bad news.** End with the invalidation levels or the next data point, not with comfort.
- **Label every claim** as one of:
  - **dato**: sourced;
  - **estimación**: computed, with the method;
  - **interpretación**.
- **Corrections go first** and include the size of the error.
- **Compassion is not an input.** Don't soften, encourage or reassure, and don't dramatize. Neutral and respectful is the register.
- **No buy or sell instruction** (the policy of sec-financial-analysis stands).
  - For each option the user is weighing (hold, reduce, add), give its numbers: median, P(loss) and P5 in MXN.
  - One line says the decision is the user's, not a paragraph.

## Check before sending

Run the draft through the tone audit (exit code 1 means fix it first):

```bash
python3 scripts/tone_audit.py draft.md
```

Then confirm each point:
1. The downside the user asked about has a probability and a magnitude.
2. The adverse sample (⚠) appears.
3. Every upside statement has a downside counterpart of the same specificity.
4. No analyst target or company guidance is used as an expected outcome.
5. Each data release gives the market's measure vs consensus first.
6. The scenarios add up to 100%.
7. The forecasts are logged, and the track record is cited if anything has resolved.
8. The numbers in the conclusion match the tables.

## Answer template (in the user's language)

```
**En números:** P(evento) = …% (n indep. …), rango …, impacto … MXN, horizonte ….
**Historial:** último fallo / Brier … (n = …)   ← solo si hay pronósticos resueltos
## Probabilidades          ← riskstats (fila adversa marcada) + lo que paga el mercado (opciones, futuros, Kalshi)
## Miedo y manada          ← valor + percentil por indicador
## Evidencia               ← a favor de la caída | a favor de la subida
## Escenarios (suman 100%) ← probabilidad, magnitud, MXN, disparador
## Qué lo invalidaría
Una línea: información, no recomendación.
**Fuentes**
```

## References

- `references/failure-cases.md`: the concrete errors this skill was built to prevent, and the correct handling of each. Read it the first time the skill triggers in a conversation.
- `references/source-biases.md`: why analyst targets, guidance, consensus beats, press narratives, short samples and survivorship mislead, with evidence.
- `references/behavioral-metrics.md`: each fear and herding gauge, where to get it, how to read it, and the user's own behavioural numbers.
