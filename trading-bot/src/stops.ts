import type { Position } from "./types.js";

export interface Bar {
  open: number;
  high: number;
  low: number;
}

export interface StopHit {
  reason: "stop-loss" | "take-profit";
  /** Trigger price: the level itself, or the bar's open when price gapped through it. */
  price: number;
}

/**
 * Did this bar hit the position's stop or take-profit? When a bar touches both we cannot know
 * which came first, so we assume the stop (the conservative choice).
 */
export function checkStops(pos: Position, bar: Bar): StopHit | null {
  const tp = pos.takeProfit;
  if (pos.side === "long") {
    if (bar.open <= pos.stop) return { reason: "stop-loss", price: bar.open };
    if (tp !== null && bar.open >= tp) return { reason: "take-profit", price: bar.open };
    if (bar.low <= pos.stop) return { reason: "stop-loss", price: pos.stop };
    if (tp !== null && bar.high >= tp) return { reason: "take-profit", price: tp };
  } else {
    if (bar.open >= pos.stop) return { reason: "stop-loss", price: bar.open };
    if (tp !== null && bar.open <= tp) return { reason: "take-profit", price: bar.open };
    if (bar.high >= pos.stop) return { reason: "stop-loss", price: pos.stop };
    if (tp !== null && bar.low <= tp) return { reason: "take-profit", price: tp };
  }
  return null;
}

/** Move the trailing stop after a closed bar. Returns the new stop, or null if it does not move. */
export function trailStop(pos: Position, bar: Bar, atr: number, multiple: number): number | null {
  if (!(multiple > 0) || !(atr > 0)) return null;
  if (pos.side === "long") {
    pos.extreme = Math.max(pos.extreme, bar.high);
    const stop = pos.extreme - multiple * atr;
    return stop > pos.stop ? stop : null;
  }
  pos.extreme = Math.min(pos.extreme, bar.low);
  const stop = pos.extreme + multiple * atr;
  return stop < pos.stop ? stop : null;
}
