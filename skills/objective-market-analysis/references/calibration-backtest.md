# Calibration backtest: which way of setting a probability scores best

Run on 31 October 2026 with `scripts/calibrate.py`:
- 26 symbols: indices, sector ETFs, megacaps, semiconductors, staples, pharma and gold.
- A forecast every 5th trading day since 1994.
- Platt recalibration fitted on dates before 2008; scores measured on 2008–2026, out of sample (about 24,000 forecasts per event).
- Re-run it after adding symbols or methods: `python3 scripts/calibrate.py --log ../../../calibration/forecasts.jsonl`.

## Results (Brier, 2008–2026)

| Event | Base rate | Floor without resolution | Climatology | Adverse sample | Vol-scaled history (fhs) | Best |
|---|---|---|---|---|---|---|
| 5 days lower | 43.8% | 0.2462 | 0.2463 | 0.2474 | 0.2463 | climatology |
| 10 days higher | 57.7% | 0.2441 | 0.2443 | 0.2460 | 0.2443 | climatology |
| 5 days ≤ −5% | 7.5% | 0.0690 | 0.0677 | 0.0680 | 0.0657 | Student-t on EWMA vol, 0.0656 |
| 5 days ≥ +5% | 9.6% | 0.0867 | 0.0830 | 0.0814 | 0.0794 | fhs10 + Platt, 0.0792 |
| 21 days ≤ −10% | 6.3% | 0.0589 | 0.0585 | 0.0595 | 0.0572 | clim10 / blend, 0.0570 |
| 63 days ≤ −10% | 11.2% | 0.0996 | 0.0996 | 0.1028 | 0.0973 | fhs |
| 63 days ≥ +10% | 28.8% | 0.2050 | 0.1941 | 0.1953 | 0.1922 | blend (fhs + climatology), 0.1897 |

The floor is the score of a forecaster who knows the period's exact base rate in advance and always says it.

## What it shows

- **Direction has no exploitable signal.**
  - No method beats the plain base rate for "higher or lower in 5, 10, 21 or 63 days".
  - An 11-signal logistic model was tested: VIX, its 5-day change, 5/21/63-day momentum scaled by volatility, distance from the 200-day average and from the 52-week high, and the volatility regime. It scored worse than the base rate out of sample (+0.0006 to +0.0011).
  - Direction forecasts are therefore near 0.245 for anyone, and should sit close to the base rate.
- **Magnitude events have some signal: volatility.**
  - Rescaling history to today's volatility (filtered historical simulation, or a Student-t on EWMA volatility) beats raw frequencies on every tail event.
  - The gain is 0.002–0.005 on scores of 0.06–0.19.
  - The 11-signal model added at most 0.0016 over fhs on these events.
- **The adverse sample over-forecasts falls in general.** It scored worse than climatology on 63-day ≤ −10% (0.1028 vs 0.0996).
  - Keep showing it as the downside reference (step 2), but do not log it as the probability.
  - Log the volatility-scaled number, and adjust it toward the options price when an event the history cannot see is inside the horizon (earnings, a Fed meeting).
- **The score depends on the question mix.**
  - On the mix logged by October 2026 (direction × 4, 5-day ±5% × 9), the best method averages 0.125 over 2008–2026.
  - The same questions asked in a high-volatility week have higher base rates and a floor near 0.19. The 13 resolved forecasts, with the probabilities given, had an expected Brier of 0.189.
- **Luck dominates small samples.**
  - If the 13 stated probabilities had been exact, 27% of draws would score 0.223 or worse (`forecast_log.py score` prints this band).
  - Re-scored point-in-time, no method would have scored below 0.211 on those 13 forecasts.

## Rules that follow

1. Log direction probabilities within a few points of the base rate for that horizon. A tilt needs a reason the backtest supports, and none of the tested signals is one.
2. For magnitude events, log the volatility-scaled probability (`fhs`, or the Student-t on EWMA volatility). Use options instead when an event the history cannot see (earnings, a Fed meeting) is inside the horizon.
3. Never improve the score by choosing which forecasts to log, editing outcomes, or adding easy low-probability forecasts the user did not need. Report Brier by type (direction / magnitude) and with its luck band so the mix cannot flatter it.
