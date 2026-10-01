import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { DEFAULT_STRATEGY, minCandles } from "./strategy.js";
import { TIMEFRAMES } from "./timeframes.js";
import type { AssetClass, Market, StrategyParams, Timeframe } from "./types.js";

/** Environment variable and value that unlock orders with real money. */
export const REAL_MONEY_ENV = "CONFIRMAR_DINERO_REAL";
export const REAL_MONEY_VALUE = "si";

const strategyShape = {
  fastEma: z.number().int().min(2).max(500),
  slowEma: z.number().int().min(3).max(1000),
  trendEma: z.number().int().min(3).max(1000),
  rsiPeriod: z.number().int().min(2).max(100),
  rsiOverbought: z.number().min(50).max(100),
  rsiOversold: z.number().min(0).max(50),
  atrPeriod: z.number().int().min(2).max(100),
  stopAtr: z.number().positive().max(20),
  takeProfitAtr: z.number().min(0).max(50),
  trailingStopAtr: z.number().min(0).max(20),
};
const strategyOverrides = z.object(strategyShape).partial().strict();

const marketSchema = (pattern: RegExp, example: string) =>
  z
    .object({
      symbol: z.string().regex(pattern, `símbolo con formato ${example}`),
      timeframe: z.enum(TIMEFRAMES as [Timeframe, ...Timeframe[]]).default("1h"),
      allowShort: z.boolean().optional(),
      strategy: strategyOverrides.optional(),
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
      })
      .strict()
      .default({}),
    strategy: strategyOverrides.default({}),
    crypto: z
      .object({
        exchange: z.string().default("binance"),
        broker: z.enum(["paper", "exchange"]).default("paper"),
        sandbox: z.boolean().default(true),
        markets: z.array(marketSchema(/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/, "BTC/USDT")).default([]),
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
    telegram: z.object({ enabled: z.boolean().default(true) }).strict().default({}),
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

  const base: StrategyParams = { ...DEFAULT_STRATEGY, ...config.strategy };
  const markets: Market[] = [];
  const add = (type: AssetClass, m: z.infer<ReturnType<typeof marketSchema>>) => {
    const [b, q] = m.symbol.split("/");
    const strategy = { ...base, ...m.strategy };
    const id = `${m.symbol} ${m.timeframe}`;
    if (strategy.fastEma >= strategy.slowEma) throw new Error(`${id}: fastEma (${strategy.fastEma}) debe ser menor que slowEma (${strategy.slowEma})`);
    if (strategy.rsiOversold >= strategy.rsiOverbought) throw new Error(`${id}: rsiOversold debe ser menor que rsiOverbought`);
    if (minCandles(strategy) + 50 > config.historyBars) throw new Error(`${id}: historyBars (${config.historyBars}) debe ser al menos ${minCandles(strategy) + 50} para calcular los indicadores`);
    if (markets.some((x) => x.id === id)) throw new Error(`Mercado duplicado: ${id}`);
    const allowShort = m.allowShort ?? type === "forex";
    if (type === "crypto" && allowShort && config.crypto.broker === "exchange") throw new Error(`${id}: el trading spot no permite cortos; quita allowShort`);
    markets.push({ id, type, symbol: m.symbol, base: b, quote: q, timeframe: m.timeframe, allowShort, strategy });
  };
  config.crypto.markets.forEach((m) => add("crypto", m));
  config.forex.markets.forEach((m) => add("forex", m));
  if (!markets.length) throw new Error("No hay mercados configurados (crypto.markets / forex.markets)");
  return { config, markets };
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
