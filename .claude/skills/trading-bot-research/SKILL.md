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

Before telling the user to install or update anything, test a fresh clone from GitHub (`git clone --branch ... && npm install && npm test`): a too-broad `.gitignore` once kept `src/data/` out of the repo while the working copy built fine. The user runs the bot on an Android phone (Termux, `scripts/android/`), so it must build with pure-JavaScript TypeScript 5 and keep data usage low (candle cache in `data/velas`). Phone UX: the user types on a phone keyboard, so everything goes through the `bot` shortcut (`scripts/android/bot.sh`) and guided helpers (`bot telegram`) instead of paths or file editing; scripts run via `curl | bash` must wrap their body in a function and keep stdin away from child commands. Updates reach the phone as commits on the branch: the bot announces pending commit subjects on Telegram and `/actualizar` installs them, so write every commit subject in plain Spanish describing what changed for the user (they read it on the phone). The phone pins a daily JSON report in the Telegram chat (authorized by the user); read it with `TELEGRAM_BOT_TOKEN=$(cat <scratchpad>/telegram.token) TELEGRAM_CHAT_ID=$(cat <scratchpad>/telegram.chat) node scripts/leer-informe.mjs <file>` from trading-bot/ — never print or commit the token.

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

- Challenge 2, wick hunter (`src/mechas`, 1-minute futures candles Jun-Sep 2026, scratch data in the session only): classic grids (paired buy/sell ladders, neutral/long/short) lose after fees or flip sign between periods; buy-only grids only ride the drift of rising coins. Orders near the price (1.5-2 σ15) win 60-79% of the time and still lose: a >50% hit rate is not an edge, the mean after costs is. Resting buys at 4·σ15 below the last close (target back to it, stop one distance, 30 min) beat random entries with identical exits (+0.66%/+0.48% vs -0.17%/-0.14%) on the study coins, but were ~0% on 14 unseen coins: coin selection drove it. Walk-forward (rank by previous month's median daily range, trade next month, 94 established perps): top 12 + leaders calm gave buys +0.35/+0.80/+0.91% and shorts +0.56/+0.42/+0.18% (Jul/Aug/Sep); picking coins by last month's strategy P&L did not persist. Wicks while BTC falls >0.3% in the same minute lose (-1.71% Aug-Sep): the opposite of the 30-min capitulation finding, where only cascades bounce. The filter can only use data known before the minute (leaders' previous 5 min > -0.2%). 1-minute OHLC simulation undercounts grid round trips when steps are tighter than the 1-minute range (random-walk control comes out negative), so only wide steps are trustworthy. Selling at the minute close when price already passed the target (bot-realistic exits) did not lower results. The bot replays September with that month's coins at 71% wins, +0.91% per buy, matching the study; its learner paused shorts by month end.
- Spot-only hosts (US) pick calmer coins for challenge 2 (spot volumes) and trade far less: judge it from the phone's report, not from a cloud run.

## Ideas not yet tested

- Live liquidation stream (`!forceOrder@arr` websocket, from Mexico) to time cascades; the archive no longer has liquidations.
- Fading leverage spikes (open interest +3% in 30 min) on futures with shorts; spot cannot short.
- Order-book imbalance and spoofing (`/api/v3/depth`), live only (no history).
- Volume/dollar bars and CUSUM event sampling, fractional differentiation, triple-barrier labels and meta-labeling (López de Prado). The adaptive layer is a simple form of meta-labeling.
- Public quant repos could not be added to the session (the add_repo request was denied by the permission system); ask the user to allow it before trying again.
- Stop-loss resting on Binance (STOP_LOSS_LIMIT / OCO) so positions stay protected with the bot off; needs testnet keys from a non-US connection.

Update the findings above when a study changes them.

## Live log (phone copy)

- 2026-10-01 17:53 → 10-02 06:00 UTC: 0 trades, and a replay of the same rules gives 0 signals. BTC +1.1%, worst 30-min BTC drop −0.79%. Closest case: ALICE −10% in 30 min on ×5.8 volume at 01:33 UTC with BTC flat (−0.16%), so the BTC filter skipped it. Over the next 2 h ALICE went flat (+0.05%, low −1.6%) and kept sliding: the drop came after a +35% intraday pump. One case, not evidence, but it fits the event study (isolated drops do not bounce). Idea to test: split flushes by the move before them (unwinding a recent pump vs a drop from a stable base).
