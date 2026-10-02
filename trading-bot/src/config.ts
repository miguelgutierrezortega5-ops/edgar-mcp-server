import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { STRATEGIES } from "./strategy.js";
import { TIMEFRAMES } from "./timeframes.js";
import type { AssetClass, Market, StrategyName, StrategyParams, Timeframe } from "./types.js";

/** Environment variable and value that unlock orders with real money. */
export const REAL_MONEY_ENV = "CONFIRMAR_DINERO_REAL";
export const REAL_MONEY_VALUE = "si";

const STRATEGY_NAMES = Object.keys(STRATEGIES) as [StrategyName, ...StrategyName[]];
const paramsSchema = z.record(z.number().finite().min(0));

const marketSchema = (pattern: RegExp, example: string) =>
  z
    .object({
      symbol: z.string().regex(pattern, `símbolo con formato ${example}`),
      timeframe: z.enum(TIMEFRAMES as [Timeframe, ...Timeframe[]]).default("1h"),
      allowShort: z.boolean().optional(),
      strategy: z.enum(STRATEGY_NAMES).default("cruce_medias"),
      params: paramsSchema.optional(),
    })
    .strict();

const configSchema = z
  .object({
    accountCurrency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
    pollSeconds: z.number().int().min(10).max(3600).default(60),
    historyBars: z.number().int().min(250).max(5000).default(720),
    dataDir: z.string().default("data"),
    paper: z
      .object({
        startingBalance: z.number().positive().default(10_000),
        cryptoFeePct: z.number().min(0).max(2).default(0.1),
        cryptoSlippagePct: z.number().min(0).max(2).default(0.05),
        forexSpreadPips: z.number().min(0).max(50).default(1.2),
        minOrderUsd: z.number().min(0).default(5),
      })
      .strict()
      .default({}),
    risk: z
      .object({
        riskPerTradePct: z.number().positive().max(10).default(1),
        maxNotionalPct: z
          .object({ crypto: z.number().positive().max(100).default(25), forex: z.number().positive().max(3000).default(500) })
          .strict()
          .default({}),
        maxOpenPositions: z.number().int().min(1).max(50).default(4),
        dailyLossLimitPct: z.number().positive().max(100).default(3),
        maxDrawdownPct: z.number().positive().max(100).default(15),
        /** Cap each position at this % of the average traded value of one bar (0 = no cap); protects thin markets. */
        maxBarVolumePct: z.number().min(0).max(1000).default(20),
      })
      .strict()
      .default({}),
    protections: z
      .object({
        /** Bars to wait before trading a market again after closing a trade in it. */
        cooldownBars: z.number().int().min(0).default(20),
        /** After this many stop-losses within stopGuardMinutes, open nothing for stopGuardPauseMinutes (0 = off). */
        stopGuardCount: z.number().int().min(0).default(3),
        stopGuardMinutes: z.number().positive().default(60),
        stopGuardPauseMinutes: z.number().positive().default(240),
      })
      .strict()
      .default({}),
    /** Recent evidence per strategy and market context scales or switches off entries (see adaptive.ts). */
    adaptive: z
      .object({
        enabled: z.boolean().default(true),
        everyHours: z.number().positive().default(4),
        windowDays: z.number().positive().max(365).default(60),
        halfLifeDays: z.number().positive().default(30),
        priorTrades: z.number().min(0).default(5),
        minProbability: z.number().min(0.5).max(0.99).default(0.55),
        fullProbability: z.number().min(0.5).max(0.999).default(0.7),
        useContexts: z.boolean().default(false),
      })
      .strict()
      .default({}),
    /** Overrides of each strategy's default parameters, for all markets that use it. */
    strategies: z.object(Object.fromEntries(STRATEGY_NAMES.map((n) => [n, paramsSchema.optional()]))).strict().default({}),
    learning: z
      .object({
        enabled: z.boolean().default(true),
        everyHours: z.number().positive().max(24 * 30).default(24),
        /** History used per market, in bars, capped at maxDays. */
        bars: z.number().int().min(1000).max(200_000).default(75_000),
        maxDays: z.number().int().min(7).max(1500).default(365),
        /** Most recent share of the history kept out of the search, to validate on unseen data. */
        testPct: z.number().min(10).max(60).default(30),
        minTrades: z.number().int().min(5).default(30),
        minProfitFactor: z.number().min(1).default(1.1),
      })
      .strict()
      .default({}),
    crypto: z
      .object({
        exchange: z.string().default("binance"),
        /** Binance futures positioning (open interest, long/short ratios, funding) for the monitor, studies and evidence. */
        futures: z.boolean().default(true),
        /** Market whose moves tell a market-wide cascade from a coin-specific drop. */
        reference: z.string().regex(/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/).default("BTC/USDT"),
        broker: z.enum(["paper", "exchange"]).default("paper"),
        sandbox: z.boolean().default(true),
        markets: z.array(marketSchema(/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/, "BTC/USDT")).default([]),
        /** Pick pairs automatically from Binance by volume, spread and age (added to `markets`). */
        autoPairs: z
          .object({
            enabled: z.boolean().default(false),
            quote: z.string().default("USDT"),
            minVolumeUsd: z.number().min(0).default(1_000_000),
            maxVolumeUsd: z.number().positive().default(8_000_000),
            maxSpreadPct: z.number().positive().default(0.2),
            minAgeDays: z.number().min(0).default(180),
            minTrades: z.number().int().min(0).default(10_000),
            max: z.number().int().min(1).max(60).default(15),
            refreshHours: z.number().positive().default(24),
            timeframe: z.enum(TIMEFRAMES as [Timeframe, ...Timeframe[]]).default("3m"),
            strategy: z.enum(STRATEGY_NAMES).default("capitulacion"),
            exclude: z.array(z.string()).default([]),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    forex: z
      .object({
        broker: z.enum(["paper", "oanda"]).default("paper"),
        data: z.enum(["yahoo", "oanda"]).default("yahoo"),
        oandaEnv: z.enum(["practice", "live"]).default("practice"),
        markets: z.array(marketSchema(/^[A-Z]{3}\/[A-Z]{3}$/, "EUR/USD")).default([]),
      })
      .strict()
      .default({}),
    /** Challenge 2, the wick hunter (src/mechas): its own simulated futures account, 1-minute orders. */
    mechas: z
      .object({
        enabled: z.boolean().default(false),
        startingBalance: z.number().positive().default(50),
        /** The most volatile coins of the last 30 days, re-chosen every `refreshDays`. */
        coins: z.number().int().min(1).max(40).default(12),
        refreshDays: z.number().positive().default(7),
        minVolumeUsd: z.number().min(0).default(20e6),
        maxVolumeUsd: z.number().positive().default(1.5e9),
        minAgeDays: z.number().int().min(31).default(60),
        exclude: z
          .array(z.string())
          .default(["BTC", "ETH", "SOL", "BNB", "XRP", "USDC", "FDUSD", "BTCDOM", "DEFI", "XAU", "XAG", "PAXG", "XAUT", "MSTR", "COIN", "CRCL", "HOOD", "NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "AMD", "INTC", "MU", "MRVL", "PLTR", "RKLB", "NBIS", "SOXL", "SPCX", "EWY", "DRAM", "LITE", "CBRS", "SNXX", "MVLL", "QQQ", "SPY", "CL"]),
        /** Big coins whose 5-minute move blocks wick buys (falling) and wick shorts (rising). */
        leaders: z.array(z.string()).default(["BTCUSDT", "ETHUSDT", "SOLUSDT"]),
        shorts: z.boolean().default(true),
        k: z.number().positive().default(4),
        takeProfit: z.number().positive().default(1),
        stop: z.number().positive().default(1),
        maxMinutes: z.number().int().positive().default(30),
        minDistancePct: z.number().min(0).default(0.3),
        throughPct: z.number().min(0).default(0.02),
        leaderMovePct: z.number().positive().default(0.2),
        /** Notional per order, % of the balance; the learner scales it down to 0 (observe only). */
        orderPct: z.number().positive().max(100).default(15),
        minOrderUsd: z.number().min(0).default(5),
        maxPositions: z.number().int().positive().default(4),
        leverage: z.number().positive().max(20).default(10),
        makerFeePct: z.number().min(0).default(0.02),
        takerFeePct: z.number().min(0).default(0.05),
        slippagePct: z.number().min(0).default(0.1),
        halfLifeDays: z.number().positive().default(30),
        /** Backtest prior (Mar–Sep 2026, both sides), worth `priorTrades` trades. */
        priorTrades: z.number().min(0).default(10),
        priorMeanPct: z.number().default(0.3),
        priorWinRate: z.number().min(0).max(1).default(0.6),
        minTrades: z.number().min(0).default(20),
        /** A side only observes when the probability that it makes money falls below this. */
        minProbability: z.number().min(0.05).max(0.99).default(0.3),
        fullProbability: z.number().min(0.5).max(0.999).default(0.85),
        /** Entry/exit variants measured in the shadow; the configured k/takeProfit/stop/maxMinutes is added if missing. */
        variants: z
          .array(z.object({ k: z.number().positive(), takeProfit: z.number().positive(), stop: z.number().positive(), maxMinutes: z.number().int().positive() }).strict())
          .default([3, 4, 5].flatMap((k) => [1, 2].flatMap((stop) => [30, 60].map((maxMinutes) => ({ k, takeProfit: 1, stop, maxMinutes }))))),
        /** Switch a side to a shadow variant that beat its own by z ≥ tuneZ over ≥ tuneMinDays days. */
        autoTune: z.boolean().default(true),
        tuneMinDays: z.number().min(1).default(60),
        tuneHalfLifeDays: z.number().positive().default(30),
        tuneZ: z.number().positive().default(3),
      })
      .strict()
      .refine((m) => m.fullProbability > m.minProbability, "mechas.fullProbability debe ser mayor que minProbability")
      .default({}),
    telegram: z
      .object({
        enabled: z.boolean().default(true),
        /** Hours between reports for Claude (pinned JSON file in the chat); 0 = only on /informe. */
        reportHours: z.number().min(0).default(24),
      })
      .strict()
      .default({}),
    /** New versions from GitHub (the branch this clone tracks). */
    updates: z
      .object({
        /** Install them without waiting for /actualizar, only while no account uses real money. */
        auto: z.boolean().default(false),
        checkHours: z.number().positive().default(6),
      })
      .strict()
      .default({}),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;

export interface LoadedConfig {
  config: Config;
  markets: Market[];
  path: string;
}

export function parseConfig(raw: unknown): { config: Config; markets: Market[] } {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(raíz)"}: ${i.message}`).join("\n");
    throw new Error(`Configuración no válida:\n${issues}`);
  }
  const config = parsed.data;
  // Prices and orders must come from the same place when trading on OANDA.
  if (config.forex.broker === "oanda") config.forex.data = "oanda";

  const markets: Market[] = [];
  const add = (type: AssetClass, m: MarketSpec) => markets.push(makeMarket(config, type, m, markets));
  config.crypto.markets.forEach((m) => add("crypto", m));
  config.forex.markets.forEach((m) => add("forex", m));
  if (!markets.length && !config.crypto.autoPairs.enabled) throw new Error("No hay mercados configurados (crypto.markets / forex.markets)");
  return { config, markets };
}

export type MarketSpec = Pick<z.infer<ReturnType<typeof marketSchema>>, "symbol" | "timeframe" | "strategy"> & Partial<z.infer<ReturnType<typeof marketSchema>>>;

/** Build and validate one market; `existing` catches duplicates. */
export function makeMarket(config: Config, type: AssetClass, m: MarketSpec, existing: Market[] = []): Market {
  {
    const [b, q] = m.symbol.split("/");
    const impl = STRATEGIES[m.strategy];
    const id = `${m.symbol} ${m.timeframe}`;
    const overrides = { ...config.strategies[m.strategy], ...m.params };
    const unknown = Object.keys(overrides).filter((k) => !(k in impl.defaults));
    if (unknown.length) throw new Error(`${id}: parámetros desconocidos para ${m.strategy}: ${unknown.join(", ")} (válidos: ${Object.keys(impl.defaults).join(", ")})`);
    const strategy: StrategyParams = { ...impl.defaults, ...overrides };
    const problem = impl.validate(strategy);
    if (problem) throw new Error(`${id}: ${problem}`);
    if (impl.minCandles(strategy) + 50 > config.historyBars) throw new Error(`${id}: historyBars (${config.historyBars}) debe ser al menos ${impl.minCandles(strategy) + 50} para calcular los indicadores`);
    if (existing.some((x) => x.id === id)) throw new Error(`Mercado duplicado: ${id}`);
    if (type === "forex" && m.timeframe === "3m") throw new Error(`${id}: ni Yahoo ni OANDA ofrecen velas de 3m en divisas`);
    const allowShort = m.allowShort ?? type === "forex";
    if (type === "crypto" && allowShort && config.crypto.broker === "exchange") throw new Error(`${id}: el trading spot no permite cortos; quita allowShort`);
    return { id, type, symbol: m.symbol, base: b, quote: q, timeframe: m.timeframe, allowShort, strategyName: m.strategy, strategy };
  }
}

export function loadConfig(path?: string): LoadedConfig {
  const file = path ?? (existsSync("config.json") ? "config.json" : "config.example.json");
  if (!existsSync(file)) throw new Error(`No existe ${file}. Copia config.example.json a config.json y ajústalo.`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${file} no es JSON válido: ${(err as Error).message}`);
  }
  return { ...parseConfig(raw), path: file };
}

/** Which configured brokers would move real money. */
export function realMoneyBrokers(config: Config, markets: Market[]): string[] {
  const out: string[] = [];
  if (markets.some((m) => m.type === "crypto") && config.crypto.broker === "exchange" && !config.crypto.sandbox) out.push(config.crypto.exchange);
  if (markets.some((m) => m.type === "forex") && config.forex.broker === "oanda" && config.forex.oandaEnv === "live") out.push("OANDA (cuenta real)");
  return out;
}
