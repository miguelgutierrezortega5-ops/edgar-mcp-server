import { alignToBars, openInterestChange, type FuturesPoint } from "./data/futures.js";
import { amihud, kyleLambda, rollingPercentile, vpin } from "./quant.js";
import { referenceMove, relativeVolume } from "./strategies/capitulation.js";
import type { Candle } from "./types.js";

// Footprints that large players leave in public market data, and an event study that measures what
// price did after each one. Used by `estudiar` (research on fresh data) and by `scan` (live monitor).

export interface Features {
  candles: Candle[];
  relVolume: number[];
  /** Share of each bar's volume bought by aggressive buyers (NaN when the source does not report it). */
  buyShare: number[];
  /** Where the close sits in the bar's range: 0 = at the low, 1 = at the high. */
  closePos: number[];
  /** Lowest low / highest high of the `swing` bars before each bar (where stop orders cluster). */
  priorLow: number[];
  priorHigh: number[];
  /** Net aggressive volume (buys - sells) over the last `swing` bars. */
  delta: number[];
  /** % move of the reference market (BTC) over the last 10 bars; NaN without reference data. */
  marketMove: number[];
  /** Percentiles (0-1) against the market's recent history: order-flow toxicity, price impact, illiquidity. */
  vpinPct: number[];
  kylePct: number[];
  amihudPct: number[];
  /** Net aggressive volume of the last 20 bars (buys - sells). */
  delta20: number[];
  /** Futures: % change of open interest in 30 minutes; crowd and top-trader long/short percentiles. */
  oiChange: number[];
  crowdPct: number[];
  topPct: number[];
}

export function features(candles: Candle[], reference?: Candle[], futures?: FuturesPoint[], swing = 60, volumeAvg = 50): Features {
  const n = candles.length;
  const f: Features = {
    candles,
    relVolume: relativeVolume(candles, volumeAvg),
    buyShare: [],
    closePos: [],
    priorLow: [],
    priorHigh: [],
    delta: [],
    marketMove: referenceMove(candles, reference, 10),
    vpinPct: [],
    kylePct: rollingPercentile(kyleLambda(candles, 60), 1000),
    amihudPct: rollingPercentile(amihud(candles, 60), 1000),
    delta20: [],
    oiChange: [],
    crowdPct: [],
    topPct: [],
  };
  const barMs = candles.length > 1 ? candles[1].time - candles[0].time : 60_000;
  const aligned = alignToBars(candles, futures ?? [], barMs);
  f.oiChange = openInterestChange(candles, futures, barMs);
  f.crowdPct = rollingPercentile(aligned.map((p) => p?.crowdRatio ?? NaN), 1000);
  f.topPct = rollingPercentile(aligned.map((p) => p?.topPositionsRatio ?? NaN), 1000);
  const volumes = candles.map((c) => c.volume).sort((a, b) => a - b);
  f.vpinPct = rollingPercentile(vpin(candles, (volumes[Math.floor(n / 2)] ?? 0) * 10, 50), 1000);
  let d20 = 0;
  candles.forEach((c, i) => {
    const d = (b: Candle) => (b.takerBuy === undefined ? 0 : 2 * b.takerBuy - b.volume);
    d20 += d(c) - (i >= 20 ? d(candles[i - 20]) : 0);
    f.delta20.push(d20);
  });
  let delta = 0;
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    f.buyShare.push(c.takerBuy !== undefined && c.volume > 0 ? c.takerBuy / c.volume : NaN);
    f.closePos.push(c.high > c.low ? (c.close - c.low) / (c.high - c.low) : 0.5);
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = Math.max(0, i - swing); j < i; j++) {
      lo = Math.min(lo, candles[j].low);
      hi = Math.max(hi, candles[j].high);
    }
    f.priorLow.push(i >= swing ? lo : NaN);
    f.priorHigh.push(i >= swing ? hi : NaN);
    const d = (b: Candle) => (b.takerBuy === undefined ? 0 : 2 * b.takerBuy - b.volume);
    delta += d(c) - (i >= swing ? d(candles[i - swing]) : 0);
    f.delta.push(delta);
  }
  return f;
}

export interface Pattern {
  name: string;
  /** Plain-language meaning. */
  meaning: string;
  needsTakerVolume?: boolean;
  needsReference?: boolean;
  needsFutures?: boolean;
  test(f: Features, i: number): boolean;
}

const move = (f: Features, i: number, bars: number) => (i >= bars ? f.candles[i].close / f.candles[i - bars].close - 1 : 0);

export const PATTERNS: Pattern[] = [
  { name: "desplome", meaning: "-3% en 10 velas con volumen ×4: barrida de stops o liquidaciones", test: (f, i) => move(f, i, 10) < -0.03 && f.relVolume[i] > 4 },
  {
    name: "desplome en cascada",
    meaning: "desplome mientras BTC cae ≥0,5%: cascada de liquidaciones, suele rebotar",
    needsReference: true,
    test: (f, i) => move(f, i, 10) < -0.03 && f.relVolume[i] > 4 && f.marketMove[i] <= -0.5,
  },
  {
    name: "desplome aislado",
    meaning: "desplome con BTC tranquilo: venta real de esa moneda, suele seguir cayendo",
    needsReference: true,
    test: (f, i) => move(f, i, 10) < -0.03 && f.relVolume[i] > 4 && f.marketMove[i] > -0.5,
  },
  { name: "bombeo", meaning: "+3% en 10 velas con volumen ×4: bombeo que suele deshacerse", test: (f, i) => move(f, i, 10) > 0.03 && f.relVolume[i] > 4 },
  {
    name: "barrida de mínimos",
    meaning: "perfora el mínimo reciente (stops) y cierra por encima, con volumen",
    test: (f, i) => f.candles[i].low < f.priorLow[i] && f.candles[i].close > f.priorLow[i] && f.relVolume[i] > 2 && f.closePos[i] > 0.6,
  },
  {
    name: "barrida de máximos",
    meaning: "supera el máximo reciente y cierra por debajo: trampa alcista",
    test: (f, i) => f.candles[i].high > f.priorHigh[i] && f.candles[i].close < f.priorHigh[i] && f.relVolume[i] > 2 && f.closePos[i] < 0.4,
  },
  {
    name: "absorción de ventas",
    meaning: "mucha venta agresiva pero el precio aguanta: alguien grande compra con órdenes límite",
    needsTakerVolume: true,
    test: (f, i) => f.relVolume[i] > 3 && f.buyShare[i] < 0.4 && f.closePos[i] > 0.5,
  },
  {
    name: "absorción de compras",
    meaning: "mucha compra agresiva pero el precio no sube: alguien grande vende",
    needsTakerVolume: true,
    test: (f, i) => f.relVolume[i] > 3 && f.buyShare[i] > 0.6 && f.closePos[i] < 0.5,
  },
  {
    name: "divergencia de flujo",
    meaning: "el precio marca mínimos mientras el flujo neto es comprador: acumulación",
    needsTakerVolume: true,
    test: (f, i) => i > 20 && f.candles[i].close < Math.min(...f.candles.slice(Math.max(0, i - 60), i - 20).map((c) => c.low)) && f.delta[i] > 0,
  },
  {
    name: "VPIN alto + venta",
    meaning: "flujo tóxico (VPIN en su 10% más alto) dominado por ventas agresivas: alguien informado vende",
    needsTakerVolume: true,
    test: (f, i) => f.vpinPct[i] > 0.9 && f.delta20[i] < 0,
  },
  {
    name: "VPIN alto + compra",
    meaning: "flujo tóxico dominado por compras agresivas: alguien informado compra",
    needsTakerVolume: true,
    test: (f, i) => f.vpinPct[i] > 0.9 && f.delta20[i] > 0,
  },
  {
    name: "libro fino (Kyle alto)",
    meaning: "cada unidad de volumen mueve mucho el precio: fácil de manipular",
    needsTakerVolume: true,
    test: (f, i) => f.kylePct[i] > 0.9,
  },
  {
    name: "apalancamiento entrando",
    meaning: "el interés abierto en futuros sube ≥3% en 30 min: entra mucho apalancamiento de golpe (medido: suele venir seguido de caídas)",
    needsFutures: true,
    test: (f, i) => f.oiChange[i] >= 3,
  },
  {
    name: "liquidaciones o cierres",
    meaning: "el interés abierto cae ≥2% en 30 min: posiciones cerradas a la fuerza o en pánico",
    needsFutures: true,
    test: (f, i) => f.oiChange[i] <= -2,
  },
  { name: "multitud muy larga", meaning: "la proporción de cuentas largas está en su 5% más alto: todos del mismo lado", needsFutures: true, test: (f, i) => f.crowdPct[i] > 0.95 },
  { name: "ballenas muy largas", meaning: "los grandes traders (por tamaño de posición) en su 5% más largo", needsFutures: true, test: (f, i) => f.topPct[i] > 0.95 },
  { name: "iliquidez alta (Amihud)", meaning: "el precio se mueve mucho para lo poco que se negocia", test: (f, i) => f.amihudPct[i] > 0.9 },
  {
    name: "ruptura con compras",
    meaning: "rompe el máximo reciente con compras agresivas (perseguir la subida)",
    needsTakerVolume: true,
    test: (f, i) => f.candles[i].close > f.priorHigh[i] && f.relVolume[i] > 2 && f.buyShare[i] > 0.6,
  },
];

const usable = (p: Pattern, f: Features, i: number) =>
  (!p.needsTakerVolume || Number.isFinite(f.buyShare[i])) && (!p.needsReference || Number.isFinite(f.marketMove[i])) && (!p.needsFutures || Number.isFinite(f.oiChange[i]) || Number.isFinite(f.crowdPct[i]));

/** Patterns present at bar `i`. */
export function footprintsAt(f: Features, i: number): string[] {
  return PATTERNS.filter((p) => usable(p, f, i) && p.test(f, i)).map((p) => p.name);
}

export const HORIZONS = [10, 20, 40, 80];

export interface PatternStats {
  pattern: Pattern;
  events: number;
  /** Mean % return from the next bar's open to the close `h` bars later, per horizon. */
  mean: number[];
  /** Share of events with a positive return at the second horizon. */
  hitRate: number;
  /** Mean at the second horizon in the first and second half of the period (is it stable?). */
  firstHalf: number;
  secondHalf: number;
  marketsPositive: number;
  markets: number;
}

/**
 * Forward returns after each pattern, pooled over markets. Events of the same pattern closer than
 * `cooldown` bars in one market count once, so a single episode is not counted many times.
 */
export function eventStudy(series: { id: string; candles: Candle[]; futures?: FuturesPoint[] }[], reference?: Candle[], cooldown = 20): { stats: PatternStats[]; baseline: number[] } {
  const H = HORIZONS;
  const base = H.map(() => [0, 0]);
  const acc = PATTERNS.map(() => ({ sum: H.map(() => 0), hits: 0, n: 0, halves: [[0, 0], [0, 0]], byMarket: new Map<string, number>() }));
  for (const { id, candles, futures } of series) {
    const f = features(candles, reference, futures);
    const last = PATTERNS.map(() => -Infinity);
    const half = Math.floor(candles.length / 2);
    for (let i = 60; i < candles.length - H.at(-1)! - 1; i++) {
      const entry = candles[i + 1].open;
      const fwd = H.map((h) => (candles[i + h].close / entry - 1) * 100);
      fwd.forEach((r, k) => {
        base[k][0] += r;
        base[k][1]++;
      });
      PATTERNS.forEach((p, k) => {
        if (i - last[k] < cooldown || !usable(p, f, i) || !p.test(f, i)) return;
        last[k] = i;
        const a = acc[k];
        a.n++;
        fwd.forEach((r, j) => (a.sum[j] += r));
        if (fwd[1] > 0) a.hits++;
        const hh = a.halves[i < half ? 0 : 1];
        hh[0] += fwd[1];
        hh[1]++;
        a.byMarket.set(id, (a.byMarket.get(id) ?? 0) + fwd[1]);
      });
    }
  }
  const stats = PATTERNS.map((pattern, k) => {
    const a = acc[k];
    return {
      pattern,
      events: a.n,
      mean: a.sum.map((s) => (a.n ? s / a.n : NaN)),
      hitRate: a.n ? (a.hits / a.n) * 100 : NaN,
      firstHalf: a.halves[0][1] ? a.halves[0][0] / a.halves[0][1] : NaN,
      secondHalf: a.halves[1][1] ? a.halves[1][0] / a.halves[1][1] : NaN,
      marketsPositive: [...a.byMarket.values()].filter((v) => v > 0).length,
      markets: a.byMarket.size,
    };
  }).filter((s) => s.events > 0);
  return { stats, baseline: base.map(([s, n]) => (n ? s / n : NaN)) };
}
