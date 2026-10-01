// Protections in the style of Freqtrade's: they stop the bot from walking into the same trap twice.
// - Cooldown: after closing a trade in a market, wait some bars before trading it again.
// - Stop-loss guard: several stop-losses in a short window mean the market is not behaving as the
//   strategy expects (a cascade that keeps falling); stop opening trades everywhere for a while.

export interface ProtectionParams {
  cooldownBars: number;
  stopGuardCount: number;
  stopGuardMinutes: number;
  stopGuardPauseMinutes: number;
}

export interface ProtectionState {
  cooldownUntil: Record<string, number>;
  recentStops: number[];
  pausedUntil: number;
}

export function newProtectionState(): ProtectionState {
  return { cooldownUntil: {}, recentStops: [], pausedUntil: 0 };
}

/** Record a closed trade. Returns a message when the stop-loss guard trips. */
export function onClose(s: ProtectionState, p: ProtectionParams, marketId: string, reason: string, time: number, barMs: number): string | null {
  if (p.cooldownBars > 0) s.cooldownUntil[marketId] = Math.max(s.cooldownUntil[marketId] ?? 0, time + p.cooldownBars * barMs);
  if (!reason.startsWith("stop-loss") || p.stopGuardCount <= 0) return null;
  const window = p.stopGuardMinutes * 60_000;
  s.recentStops = [...s.recentStops.filter((t) => time - t < window), time];
  if (s.recentStops.length < p.stopGuardCount) return null;
  s.recentStops = [];
  s.pausedUntil = time + p.stopGuardPauseMinutes * 60_000;
  return `${p.stopGuardCount} stop-loss en ${p.stopGuardMinutes} min: no se abren operaciones hasta ${new Date(s.pausedUntil).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Why a new trade in this market is blocked right now, or null. */
export function blocked(s: ProtectionState, marketId: string, time: number): string | null {
  if (time < s.pausedUntil) return "pausa por racha de stop-loss";
  if (time < (s.cooldownUntil[marketId] ?? 0)) return "enfriamiento tras la última operación en este mercado";
  return null;
}
