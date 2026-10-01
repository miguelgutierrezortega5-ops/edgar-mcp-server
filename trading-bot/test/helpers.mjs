// Shared fixtures for the tests (not a test file itself).
import { emaCross } from "../dist/strategies/ema.js";

export const HOUR = 3_600_000;
export const T0 = Date.UTC(2026, 0, 5); // a Monday

export const RISK = {
  riskPerTradePct: 1,
  maxNotionalPct: { crypto: 25, forex: 500 },
  maxOpenPositions: 4,
  dailyLossLimitPct: 3,
  maxDrawdownPct: 15,
  maxBarVolumePct: 20,
};

export const COSTS = { cryptoFeePct: 0.1, cryptoSlippagePct: 0.05, forexSpreadPips: 1 };

export const FAST = { ...emaCross.defaults, fastEma: 3, slowEma: 6, trendEma: 10, rsiPeriod: 5, atrPeriod: 5, rsiOverbought: 100, rsiOversold: 0 };

export function market(symbol, overrides = {}) {
  const [base, quote] = symbol.split("/");
  const type = overrides.type ?? (["USD", "EUR", "GBP", "JPY", "CHF"].includes(base) ? "forex" : "crypto");
  return { id: `${symbol} 1h`, type, symbol, base, quote, timeframe: "1h", allowShort: type === "forex", strategyName: "cruce_medias", strategy: FAST, ...overrides };
}

/** Hourly bars from closes; each bar opens at the previous close and spans ±0.5% around its range. */
export function bars(closes, start = T0, spread = 0.005) {
  return closes.map((close, i) => {
    const open = i ? closes[i - 1] : close;
    return { time: start + i * HOUR, open, high: Math.max(open, close) * (1 + spread), low: Math.min(open, close) * (1 - spread), close, volume: 1e6 };
  });
}

/** Falls from 100 to 80, then climbs back: produces a bullish crossover above the trend EMA. */
export function vShape() {
  const closes = [];
  for (let i = 0; i < 30; i++) closes.push(100 - i * 0.7);
  for (let i = 1; i <= 40; i++) closes.push(closes[29] + i * 1.2);
  return closes;
}
