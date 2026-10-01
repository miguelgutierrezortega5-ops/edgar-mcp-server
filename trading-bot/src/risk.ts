import type { AssetClass } from "./types.js";

export interface RiskParams {
  /** Share of equity lost if a trade hits its stop. */
  riskPerTradePct: number;
  /** Largest position value as a share of equity, per asset class (forex above 100% means leverage). */
  maxNotionalPct: Record<AssetClass, number>;
  maxOpenPositions: number;
  /** Stop opening trades for the rest of the UTC day after losing this share of the day's starting equity. */
  dailyLossLimitPct: number;
  /** Close everything and halt after falling this far below peak equity. */
  maxDrawdownPct: number;
}

export interface RiskState {
  peakEquity: number;
  /** UTC date (YYYY-MM-DD) of `dayStartEquity`. */
  day: string;
  dayStartEquity: number;
  /** Why trading was halted; cleared by hand with `status --reanudar`. */
  halted: string | null;
}

export function newRiskState(equity: number, now: number): RiskState {
  return { peakEquity: equity, day: utcDay(now), dayStartEquity: equity, halted: null };
}

function utcDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** Roll the day, track the peak and trip the drawdown breaker. Returns true when the breaker trips now. */
export function updateRisk(state: RiskState, params: RiskParams, equity: number, now: number): boolean {
  const day = utcDay(now);
  if (day !== state.day) {
    state.day = day;
    state.dayStartEquity = equity;
  }
  state.peakEquity = Math.max(state.peakEquity, equity);
  const drawdown = state.peakEquity > 0 ? (1 - equity / state.peakEquity) * 100 : 0;
  if (!state.halted && drawdown >= params.maxDrawdownPct) {
    state.halted = `drawdown del ${drawdown.toFixed(1)}% desde el máximo (${state.peakEquity.toFixed(2)}), límite ${params.maxDrawdownPct}%`;
    return true;
  }
  return false;
}

export function canOpen(state: RiskState, params: RiskParams, equity: number, openPositions: number): { ok: true } | { ok: false; reason: string } {
  if (state.halted) return { ok: false, reason: `bot detenido: ${state.halted}` };
  if (openPositions >= params.maxOpenPositions) return { ok: false, reason: `máximo de ${params.maxOpenPositions} posiciones abiertas` };
  const dayLoss = state.dayStartEquity > 0 ? (1 - equity / state.dayStartEquity) * 100 : 0;
  if (dayLoss >= params.dailyLossLimitPct) return { ok: false, reason: `pérdida diaria del ${dayLoss.toFixed(1)}% (límite ${params.dailyLossLimitPct}%)` };
  if (!(equity > 0)) return { ok: false, reason: "sin capital" };
  return { ok: true };
}

/**
 * Units to trade so that hitting the stop loses `riskPerTradePct` of equity, capped by the
 * maximum position value. `rate` converts the market's quote currency into the account currency.
 */
export function positionSize(args: { equity: number; price: number; stopDistance: number; rate: number; type: AssetClass; params: RiskParams }): number {
  const { equity, price, stopDistance, rate, type, params } = args;
  if (!(equity > 0 && price > 0 && stopDistance > 0 && rate > 0)) return 0;
  const byRisk = (equity * params.riskPerTradePct) / 100 / (stopDistance * rate);
  const byNotional = (equity * params.maxNotionalPct[type]) / 100 / (price * rate);
  return Math.min(byRisk, byNotional);
}
