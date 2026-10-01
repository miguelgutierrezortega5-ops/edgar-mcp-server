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

Data: `data-api.binance.vision/api/v3/klines` (public, global, includes taker-buy volume) via `src/data/binance.ts`. Binance futures endpoints (`fapi.binance.com`) are geo-blocked from US cloud containers but work from Mexico.

Token-efficient workflow: put research scripts in the scratchpad, cache klines to disk, print one compact table per run, and reuse `npm run estudiar` / `npm run aprender` instead of ad-hoc dumps.

## Findings so far (Binance spot, 16 pairs of $1-8M/day, 3m bars, May-Oct 2026)

- Capitulation (-3% in 10 bars on 4x volume) bounces **only when BTC falls too** (liquidation cascade): PF 1.7-3.3 in both halves. Isolated flushes (BTC calm) lose: real selling.
- Pumps (+3% / 10 bars, 4x volume) revert -0.4% to -0.7%. Highs swept and closed back below: negative. Breakouts with aggressive buying: no follow-through.
- Wide stops (1.5 ATR under the flush low) work; 0.5 ATR stops get hunted.
- EMA crossover loses on BTC/ETH 1h; forex needed slower settings (20/100, stop 3 ATR).
- Always judge with the portfolio simulator (`simulate`, one shared account, `maxOpenPositions`): per-market backtests overstated capitulation (PF 2.17 → 1.36 shared). Protections (cooldown 20 bars, 3 stop-losses in 60 min → 4 h pause) brought it to PF 1.88, max drawdown 2.4%, +7.7% in 150 days.
- Keep losing strategies out of a shared account: they take the position slots and trip the drawdown halt. Crypto and forex now have separate paper accounts.

## Ideas not yet tested

- Futures data from Mexico: liquidations, funding, open interest, top-trader long/short ratio, to confirm cascades.
- Order-book imbalance and spoofing (`/api/v3/depth`), live only (no history).
- Stop-loss resting on Binance (STOP_LOSS_LIMIT / OCO) so positions stay protected with the bot off; needs testnet keys from a non-US connection.

Update the findings above when a study changes them.
