import type { Exchange, Order } from "ccxt";
import type { ClosedTrade, Market, Position, PriceMark } from "../types.js";
import type { Broker, CloseRequest, OpenRequest } from "./broker.js";

// Spot trading on any ccxt exchange. Spot accounts cannot short, and the stop-loss / take-profit are
// watched by the bot (exchanges disagree on stop-order types), so they only act while it runs.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Fee {
  cost?: number;
  currency?: string;
}

export class ExchangeBroker implements Broker {
  readonly name: string;
  readonly managesStops = false;
  private markets: Market[] = [];

  constructor(
    private readonly ex: Exchange,
    readonly realMoney: boolean,
  ) {
    this.name = realMoney ? ex.id : `${ex.id}-testnet`;
  }

  async init(markets: Market[]): Promise<void> {
    this.markets = markets;
    await this.ex.loadMarkets();
    for (const m of markets) {
      if (!this.ex.markets?.[m.symbol]) throw new Error(`${this.ex.id} no tiene el par ${m.symbol}`);
      if (m.allowShort) throw new Error(`${m.symbol}: el trading spot no permite cortos (allowShort: false)`);
    }
    if (!this.ex.has.fetchBalance || !this.ex.has.createOrder) throw new Error(`${this.ex.id} no permite consultar saldo u operar mediante ccxt`);
  }

  async equity(_positions: Position[], marks: Map<string, PriceMark>): Promise<number> {
    const balance = await this.ex.fetchBalance();
    const total = balance.total as unknown as Record<string, number | undefined>;
    const seen = new Set<string>();
    let equity = 0;
    for (const m of this.markets) {
      const mark = marks.get(m.id);
      if (!mark) continue;
      if (!seen.has(m.quote)) {
        seen.add(m.quote);
        equity += (total[m.quote] ?? 0) * mark.rate;
      }
      if (!seen.has(m.base)) {
        seen.add(m.base);
        equity += (total[m.base] ?? 0) * mark.price * mark.rate;
      }
    }
    return equity;
  }

  normalizeUnits(market: Market, units: number, price: number): number {
    const info = this.ex.markets?.[market.symbol];
    let amount: number;
    try {
      amount = Number(this.ex.amountToPrecision(market.symbol, units));
    } catch {
      return 0; // below the exchange's precision
    }
    if (!(amount > 0)) return 0;
    if (info?.limits?.amount?.min && amount < info.limits.amount.min) return 0;
    if (info?.limits?.cost?.min && amount * price < info.limits.cost.min) return 0;
    return amount;
  }

  private async free(currency: string): Promise<number> {
    const balance = await this.ex.fetchBalance();
    return (balance.free as unknown as Record<string, number | undefined>)[currency] ?? 0;
  }

  /** Market orders may come back before the exchange reports the fill; poll until they settle. */
  private async settle(order: Order, symbol: string): Promise<Order> {
    const id = String(order.id);
    for (let i = 0; i < 10 && (order.status !== "closed" || !order.filled) && this.ex.has.fetchOrder; i++) {
      await sleep(1000);
      order = await this.ex.fetchOrder(id, symbol);
    }
    if (!order.filled) throw new Error(`La orden ${order.id} en ${this.ex.id} no consta como ejecutada (estado: ${order.status}). Revísala en el exchange.`);
    return order;
  }

  /** Fees in quote currency, and how much of the base asset they took. */
  private fees(order: Order, market: Market, price: number): { quote: number; base: number } {
    const all = (order as Order & { fees?: Fee[] }).fees;
    const fees: Fee[] = all?.length ? all : order.fee ? [order.fee] : [];
    let quote = 0;
    let base = 0;
    for (const f of fees) {
      if (!f.cost) continue;
      if (f.currency === market.quote) quote += f.cost;
      else if (f.currency === market.base) {
        base += f.cost;
        quote += f.cost * price;
      }
      // Fees paid in a third token (e.g. BNB) are not counted.
    }
    return { quote, base };
  }

  private async marketOrder(market: Market, side: "buy" | "sell", amount: number, price: number): Promise<{ order: Order; filled: number; average: number }> {
    const needsPrice = side === "buy" && Boolean((this.ex.options as Record<string, unknown>)?.createMarketBuyOrderRequiresPrice);
    const placed = await this.ex.createOrder(market.symbol, "market", side, amount, needsPrice ? price : undefined);
    const order = await this.settle(placed, market.symbol);
    const filled = order.filled ?? 0;
    const average = order.average ?? (order.cost && filled ? order.cost / filled : price);
    return { order, filled, average };
  }

  async open(req: OpenRequest): Promise<Position> {
    const { market } = req;
    if (req.side !== "long") throw new Error("El trading spot solo admite compras");
    const affordable = this.normalizeUnits(market, (await this.free(market.quote)) / (req.price * 1.01), req.price);
    const units = Math.min(req.units, affordable);
    if (!(units > 0)) throw new Error(`Saldo de ${market.quote} insuficiente en ${this.ex.id} para la orden mínima`);
    const { order, filled, average } = await this.marketOrder(market, "buy", units, req.price);
    const fees = this.fees(order, market, average);
    return {
      id: `X${String(order.id)}`,
      broker: this.name,
      marketId: market.id,
      symbol: market.symbol,
      type: market.type,
      side: "long",
      units: filled - fees.base,
      entryPrice: average,
      stop: average - req.stopDistance,
      takeProfit: req.takeProfitDistance === null ? null : average + req.takeProfitDistance,
      openedAt: req.time,
      entryFee: fees.quote * req.rate,
      extreme: average,
      brokerRef: String(order.id),
    };
  }

  async close(pos: Position, req: CloseRequest): Promise<ClosedTrade> {
    const { market } = req;
    const free = await this.free(market.base);
    const amount = this.normalizeUnits(market, Math.min(pos.units, free), req.price);
    if (!(amount > 0)) throw new Error(`No hay ${market.base} disponible para vender en ${this.ex.id} (posición ${pos.units}, libre ${free})`);
    const { order, filled, average } = await this.marketOrder(market, "sell", amount, req.price);
    const exitFee = this.fees(order, market, average).quote * req.rate;
    const gross = (average - pos.entryPrice) * filled * req.rate;
    return { ...pos, exitPrice: average, closedAt: req.time, pnl: gross - exitFee - pos.entryFee, fees: pos.entryFee + exitFee, reason: req.reason };
  }

  async updateStop(pos: Position, stop: number): Promise<void> {
    pos.stop = stop;
  }
}
