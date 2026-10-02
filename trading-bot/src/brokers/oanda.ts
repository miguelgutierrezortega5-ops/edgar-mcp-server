import { HttpError } from "../http.js";
import { oandaInstrument, type OandaClient } from "../data/oanda.js";
import type { ClosedTrade, Market, Position } from "../types.js";
import type { Broker, CloseRequest, OpenRequest } from "./broker.js";

// OANDA v20 REST API. Stop-loss and take-profit are attached to each trade on OANDA's side,
// so they keep protecting the position even while the bot is offline.

interface Instrument {
  name: string;
  displayPrecision: number;
  tradeUnitsPrecision: number;
  minimumTradeSize: string;
}

interface Fill {
  price: string;
  pl?: string;
  financing?: string;
  commission?: string;
  time?: string;
  tradeOpened?: { tradeID: string; units: string; price: string };
}

interface OrderResponse {
  orderFillTransaction?: Fill;
  orderCancelTransaction?: { reason: string };
}

interface Trade {
  id: string;
  instrument: string;
  state: "OPEN" | "CLOSED" | "CLOSE_WHEN_TRADEABLE";
  averageClosePrice?: string;
  realizedPL?: string;
  financing?: string;
  closeTime?: string;
  stopLossOrder?: { state: string };
  takeProfitOrder?: { state: string };
}

const num = (v: string | undefined) => (v === undefined ? 0 : Number(v));

export class OandaBroker implements Broker {
  readonly name = "oanda";
  readonly managesStops = true;
  readonly realMoney: boolean;
  private instruments = new Map<string, Instrument>();

  constructor(private readonly client: OandaClient) {
    this.realMoney = client.env === "live";
  }

  async init(markets: Market[]): Promise<void> {
    const names = markets.map(oandaInstrument).join(",");
    const res = await this.client.request<{ instruments: Instrument[] }>(this.client.account(`/instruments?instruments=${names}`));
    for (const i of res.instruments) this.instruments.set(i.name, i);
    const missing = markets.filter((m) => !this.instruments.has(oandaInstrument(m)));
    if (missing.length) throw new Error(`OANDA no ofrece ${missing.map((m) => m.symbol).join(", ")} en esta cuenta`);
  }

  private instrument(market: Pick<Market, "base" | "quote">): Instrument {
    const i = this.instruments.get(oandaInstrument(market));
    if (!i) throw new Error(`Instrumento ${oandaInstrument(market)} no inicializado`);
    return i;
  }

  private fmt(market: Market, price: number): string {
    return price.toFixed(this.instrument(market).displayPrecision);
  }

  async equity(): Promise<number> {
    const res = await this.client.request<{ account: { NAV: string } }>(this.client.account("/summary"));
    return Number(res.account.NAV);
  }

  normalizeUnits(market: Market, units: number): number {
    const i = this.instrument(market);
    const f = 10 ** i.tradeUnitsPrecision;
    const rounded = Math.floor(units * f) / f;
    return rounded >= Math.max(Number(i.minimumTradeSize), 1 / f) ? rounded : 0;
  }

  async open(req: OpenRequest): Promise<Position> {
    const { market } = req;
    const long = req.side === "long";
    const takeProfit = req.takeProfitDistance === null ? null : Number(this.fmt(market, req.price + (long ? 1 : -1) * req.takeProfitDistance));
    const res = await this.client.request<OrderResponse>(this.client.account("/orders"), {
      method: "POST",
      body: {
        order: {
          type: "MARKET",
          instrument: oandaInstrument(market),
          units: String(long ? req.units : -req.units),
          timeInForce: "FOK",
          positionFill: "OPEN_ONLY",
          stopLossOnFill: { distance: this.fmt(market, req.stopDistance), timeInForce: "GTC" },
          ...(takeProfit === null ? {} : { takeProfitOnFill: { price: this.fmt(market, takeProfit), timeInForce: "GTC" } }),
        },
      },
    });
    const opened = res.orderFillTransaction?.tradeOpened;
    if (!opened) throw new Error(`OANDA no ejecutó la orden: ${res.orderCancelTransaction?.reason ?? "sin respuesta de ejecución"}`);
    const entryPrice = Number(opened.price);
    return {
      id: `O${opened.tradeID}`,
      broker: this.name,
      marketId: market.id,
      symbol: market.symbol,
      type: market.type,
      side: req.side,
      units: Math.abs(Number(opened.units)),
      entryPrice,
      stop: entryPrice + (long ? -1 : 1) * req.stopDistance,
      takeProfit,
      openedAt: req.time,
      entryFee: Math.abs(num(res.orderFillTransaction?.commission)),
      extreme: entryPrice,
      brokerRef: opened.tradeID,
    };
  }

  async close(pos: Position, req: CloseRequest): Promise<ClosedTrade> {
    let res: OrderResponse;
    try {
      res = await this.client.request<OrderResponse>(this.client.account(`/trades/${pos.brokerRef}/close`), { method: "PUT", body: { units: "ALL" } });
    } catch (err) {
      // Already closed on OANDA's side (its own stop or take-profit): report how it ended.
      if (err instanceof HttpError && (err.status === 404 || err.status === 400)) {
        const done = await this.closedTrade(pos);
        if (done) return done;
      }
      throw err;
    }
    const fill = res.orderFillTransaction;
    if (!fill) throw new Error(`OANDA no cerró la operación ${pos.brokerRef}: ${res.orderCancelTransaction?.reason ?? "sin respuesta"}`);
    const commission = Math.abs(num(fill.commission));
    return {
      ...pos,
      exitPrice: Number(fill.price),
      closedAt: fill.time ? Math.round(Number(fill.time) * 1000) : req.time,
      pnl: num(fill.pl) + num(fill.financing) - commission - pos.entryFee,
      fees: pos.entryFee + commission,
      reason: req.reason,
    };
  }

  async updateStop(pos: Position, stop: number): Promise<void> {
    const market = { base: pos.symbol.split("/")[0], quote: pos.symbol.split("/")[1] };
    const price = stop.toFixed(this.instrument(market).displayPrecision);
    await this.client.request(this.client.account(`/trades/${pos.brokerRef}/orders`), { method: "PUT", body: { stopLoss: { price, timeInForce: "GTC" } } });
    pos.stop = Number(price);
  }

  async reconcile(positions: Position[]): Promise<ClosedTrade[]> {
    const mine = positions.filter((p) => p.broker === this.name);
    if (!mine.length) return [];
    const res = await this.client.request<{ trades: { id: string }[] }>(this.client.account("/openTrades"));
    const open = new Set(res.trades.map((t) => t.id));
    const closed: ClosedTrade[] = [];
    for (const pos of mine) {
      if (open.has(pos.brokerRef ?? "")) continue;
      const done = await this.closedTrade(pos);
      if (done) closed.push(done);
    }
    return closed;
  }

  private async closedTrade(pos: Position): Promise<ClosedTrade | null> {
    const { trade } = await this.client.request<{ trade: Trade }>(this.client.account(`/trades/${pos.brokerRef}`));
    if (trade.state !== "CLOSED") return null;
    const reason =
      trade.stopLossOrder?.state === "FILLED" ? "stop-loss (OANDA)" : trade.takeProfitOrder?.state === "FILLED" ? "take-profit (OANDA)" : "cerrada en OANDA";
    return {
      ...pos,
      exitPrice: num(trade.averageClosePrice),
      closedAt: trade.closeTime ? Math.round(Number(trade.closeTime) * 1000) : Date.now(),
      pnl: num(trade.realizedPL) + num(trade.financing) - pos.entryFee,
      fees: pos.entryFee,
      reason,
    };
  }
}

