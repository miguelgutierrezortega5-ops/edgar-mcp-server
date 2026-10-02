import type { CoinInfo, MinuteSource } from "../data/futures1m.js";

// Which altcoins to hunt: the most volatile of the last 30 days among liquid, established perpetuals.
// Measured walk-forward (choose with the previous month, trade the next): the 12 most volatile gave
// +0.35% / +0.80% / +0.91% per wick buy in Jul / Aug / Sep 2026, all 94 coins +0.26%; choosing the
// coins where the strategy had just earned most did not persist (-0.22% in September).

export interface UniverseConfig {
  coins: number;
  minVolumeUsd: number;
  maxVolumeUsd: number;
  minAgeDays: number;
  exclude: string[];
}

export interface Pick {
  symbol: string;
  /** Median daily high/low range of the last 30 days, as a fraction. */
  range: number;
  tick: number;
}

export function medianRange(days: { high: number; low: number }[]): number {
  const r = days.filter((d) => d.low > 0).map((d) => d.high / d.low - 1).sort((a, b) => a - b);
  return r.length ? r[r.length >> 1] : NaN;
}

/** Liquid crypto perpetuals in the volume band, not excluded. */
export function eligible(coins: CoinInfo[], c: UniverseConfig): CoinInfo[] {
  const exclude = new Set(c.exclude.map((s) => (s.endsWith("USDT") ? s : `${s}USDT`)));
  return coins.filter((x) => x.crypto && !exclude.has(x.symbol) && x.quoteVolume >= c.minVolumeUsd && x.quoteVolume <= c.maxVolumeUsd);
}

export async function selectCoins(src: MinuteSource, c: UniverseConfig, log: (msg: string) => void = () => {}): Promise<Pick[]> {
  const candidates = eligible(await src.coins(), c);
  const ranked: Pick[] = [];
  for (const x of candidates) {
    try {
      const days = await src.days(x.symbol, c.minAgeDays + 1);
      if (days.length <= c.minAgeDays) continue; // too new: no history to trust
      ranked.push({ symbol: x.symbol, range: medianRange(days.slice(-31, -1)), tick: x.tick });
    } catch (err) {
      log(`Reto 2: sin datos diarios de ${x.symbol} (${(err as Error).message})`);
    }
  }
  return ranked.filter((p) => Number.isFinite(p.range)).sort((a, b) => b.range - a.range).slice(0, c.coins);
}
