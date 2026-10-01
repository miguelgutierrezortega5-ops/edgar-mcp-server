---
name: trading-bot-research
description: Research, tune and extend the crypto/forex trading bot in trading-bot/ (whale footprints, capitulation strategy, walk-forward learning). Use when asked to improve the bot's strategies, study market behaviour (whales, manipulation, pumps, stop hunts, liquidation cascades), add a strategy or data source, or review its results.
---

# Trading bot research

The bot lives in `trading-bot/` (TypeScript, `npm test` offline). Read `trading-bot/README.md` for usage.

## Method (keep it, it is what makes results trustworthy)

1. **Measure before building.** Turn an idea into a detector and run an event study: mean forward return after the event, at several horizons, from the *next* bar's open, against the all-bars baseline and the round-trip cost (~0.3% on Binance spot with slippage).
2. **Check look-ahead bias** with `npm run verificar` after changing a strategy.
3. **Split time.** Discover on the older part, validate on the newer part. Report only what holds in both, in most markets, and above costs.
4. **Simulate real trades** (stop, target, time stop, fees) before trusting an event study: averages can hide paths that hit the stop first.
5. **Count independent episodes, not trades.** Crypto events cluster (one crash day fires a dozen coins). Group by day.
6. **Never tune on the data you report.** The learner (`src/learn.ts`) does walk-forward; say plainly when a result is in-sample.

Data: `data-api.binance.vision/api/v3/klines` (public, global, includes taker-buy volume) via `src/data/binance.ts`. Futures positioning via `src/data/futures.ts`: `data.binance.vision` daily `metrics` zips (5-min open interest, top-trader and global long/short ratios, taker ratio; complete days up to yesterday, reachable from US containers) and monthly `fundingRate`; `fapi.binance.com` fills the current day but is geo-blocked from US containers (works from Mexico). Liquidation snapshots are no longer in the archive.

Token-efficient workflow: put research scripts in the scratchpad, cache klines to disk, print one compact table per run, and reuse `npm run estudiar` / `npm run aprender` instead of ad-hoc dumps.

## Findings so far (Binance spot, 16 pairs of $1-8M/day, 3m bars, May-Oct 2026)

- Capitulation (-3% in 10 bars on 4x volume) bounces **only when BTC falls too** (liquidation cascade): PF 1.7-3.3 in both halves. Isolated flushes (BTC calm) lose: real selling.
- Pumps (+3% / 10 bars, 4x volume) revert -0.4% to -0.7%. Highs swept and closed back below: negative. Breakouts with aggressive buying: no follow-through.
- Wide stops (1.5 ATR under the flush low) work; 0.5 ATR stops get hunted.
- EMA crossover loses on BTC/ETH 1h; forex needed slower settings (20/100, stop 3 ATR).
- Always judge with the portfolio simulator (`simulate`, one shared account, `maxOpenPositions`): per-market backtests overstated capitulation (PF 2.17 → 1.36 shared). Protections (cooldown 20 bars, 3 stop-losses in 60 min → 4 h pause) brought it to PF 1.88, max drawdown 2.4%, +7.7% in 150 days.
- Keep losing strategies out of a shared account: they take the position slots and trip the drawdown halt. Crypto and forex now have separate paper accounts.

- Microstructure algorithms (src/quant.ts), measured May-Oct 2026: VPIN, Kyle's lambda, Amihud alone have no stable edge (they track each period's drift). As context for capitulation: high VPIN helped and high Amihud hurt in both halves, but with 9-35 cases. Hurst's relation to capitulation flipped sign between halves: do not use it as a filter.
- The adaptive layer (decayed evidence per strategy x context, half-life 30 days) did not raise returns over a period where the edge held (+7.26% vs +7.65%); with a 10-day half-life it cost 3 points. Treat it as insurance, and re-measure it when the edge fades.
- Deflated Sharpe of the learner's best combination: 0.42 (capitulation, 216 trials) and 0.08 (forex EMA, 108 trials): grid winners were mostly luck.
- The user insists that nothing in this market is a law: present every finding as "measured in period X", keep re-measuring, and prefer mechanisms that adapt over hard-coded filters.

- Futures (150 days, 15 pairs): open interest +3% in 30 min was followed by -0.2% to -0.6% over 4 h in both halves (baseline -0.09%/+0.12%), confirmed again on the last 60 days. Other futures readings track the baseline. Capitulation split by open-interest change flips between halves: not a filter.
- Adaptive sizing by context (toxicity, liquidity, futures), even judged one dimension at a time, did worse than the group-only evidence (PF 1.67 vs 1.82; none 1.85): `useContexts` is off by default.

- $50 challenge (150 days + 10,000-path day-block bootstrap): more risk per trade or fewer, larger positions made results worse (2%/50%: -3%; 5%/100%: -11%); the best was diversified (1% risk, 12.5% per position, 8 positions: +8.0%, drawdown 2%). P(50 -> 250 within a year) was 0% at every level. Do not promise growth targets; size small and spread out.
- Paper/backtests now enforce Binance's 5 USD minimum order and spot cash (no leverage): needed for small accounts.

## Ideas not yet tested

- Live liquidation stream (`!forceOrder@arr` websocket, from Mexico) to time cascades; the archive no longer has liquidations.
- Fading leverage spikes (open interest +3% in 30 min) on futures with shorts; spot cannot short.
- Order-book imbalance and spoofing (`/api/v3/depth`), live only (no history).
- Volume/dollar bars and CUSUM event sampling, fractional differentiation, triple-barrier labels and meta-labeling (López de Prado). The adaptive layer is a simple form of meta-labeling.
- Public quant repos could not be added to the session (the add_repo request was denied by the permission system); ask the user to allow it before trying again.
- Stop-loss resting on Binance (STOP_LOSS_LIMIT / OCO) so positions stay protected with the bot off; needs testnet keys from a non-US connection.

Update the findings above when a study changes them.
