import type { Broker } from "./brokers/broker.js";
import { ExchangeBroker } from "./brokers/exchange.js";
import { OandaBroker } from "./brokers/oanda.js";
import { PaperBroker } from "./brokers/paper.js";
import { REAL_MONEY_ENV, REAL_MONEY_VALUE, realMoneyBrokers, type Config } from "./config.js";
import { BinanceSource } from "./data/binance.js";
import { CcxtSource, createExchange } from "./data/ccxt.js";
import { OandaClient, OandaSource } from "./data/oanda.js";
import type { CandleSource } from "./data/source.js";
import { YahooFxSource } from "./data/yahoo.js";
import { paperName, type BotState } from "./store.js";
import type { AssetClass, Market } from "./types.js";

function requireEnv(...names: string[]): string[] {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) throw new Error(`Faltan variables de entorno: ${missing.join(", ")} (ponlas en el archivo .env)`);
  return names.map((n) => process.env[n]!);
}

let oanda: OandaClient | undefined;
function oandaClient(config: Config): OandaClient {
  if (!oanda) {
    const [key, account] = requireEnv("OANDA_API_KEY", "OANDA_ACCOUNT_ID");
    oanda = new OandaClient(key, account, config.forex.oandaEnv);
  }
  return oanda;
}

export interface Sources {
  sources: Partial<Record<AssetClass, CandleSource>>;
  fx: YahooFxSource;
}

/** Market data. Crypto prices always come from the real exchange (testnets have unrealistic prices). */
export function buildSources(config: Config, markets: Market[]): Sources {
  const fx = new YahooFxSource();
  const sources: Partial<Record<AssetClass, CandleSource>> = {};
  if (markets.some((m) => m.type === "crypto")) {
    sources.crypto = config.crypto.exchange === "binance" ? new BinanceSource() : new CcxtSource(createExchange(config.crypto.exchange));
  }
  if (markets.some((m) => m.type === "forex")) sources.forex = config.forex.data === "oanda" ? new OandaSource(oandaClient(config)) : fx;
  return { sources, fx };
}

export function buildBrokers(config: Config, markets: Market[], state: BotState): Partial<Record<AssetClass, Broker>> {
  const real = realMoneyBrokers(config, markets);
  if (real.length && process.env[REAL_MONEY_ENV] !== REAL_MONEY_VALUE) {
    throw new Error(
      `La configuración opera con DINERO REAL en: ${real.join(", ")}.\n` +
        `Si es lo que quieres, añade ${REAL_MONEY_ENV}=${REAL_MONEY_VALUE} al archivo .env. ` +
        `Antes, prueba la estrategia con backtest y en modo paper o en una cuenta de pruebas.`,
    );
  }
  const paper = (type: AssetClass) => new PaperBroker(state.papers[type], config.paper, paperName(type));
  const brokers: Partial<Record<AssetClass, Broker>> = {};
  if (markets.some((m) => m.type === "crypto")) {
    if (config.crypto.broker === "exchange") {
      const [apiKey, secret] = requireEnv("CRYPTO_API_KEY", "CRYPTO_API_SECRET");
      const ex = createExchange(config.crypto.exchange, { apiKey, secret, password: process.env.CRYPTO_API_PASSWORD }, config.crypto.sandbox);
      brokers.crypto = new ExchangeBroker(ex, !config.crypto.sandbox);
    } else brokers.crypto = paper("crypto");
  }
  if (markets.some((m) => m.type === "forex")) brokers.forex = config.forex.broker === "oanda" ? new OandaBroker(oandaClient(config)) : paper("forex");
  return brokers;
}
