import type { ClosedTrade, Market, Position, PriceMark } from "../types.js";
import { unrealized, type Broker, type CloseRequest, type OpenRequest } from "./broker.js";

export interface PaperCosts {
  /** Exchange fee per side, as a % of the trade value. */
  cryptoFeePct: number;
  /** Price slippage per side, as a %. */
  cryptoSlippagePct: number;
  /** Full bid/ask spread in pips; each side pays half. */
  forexSpreadPips: number;
}

export interface PaperBook {
  balance: number;
  nextId: number;
}

export function pipSize(market: Pick<Market, "quote">): number {
  return market.quote === "JPY" ? 0.01 : 0.0001;
}

export function fillPrice(market: Market, buy: boolean, mid: number, costs: PaperCosts): number {
  const dir = buy ? 1 : -1;
  if (market.type === "crypto") return mid * (1 + (dir * costs.cryptoSlippagePct) / 100);
  return mid + (dir * costs.forexSpreadPips * pipSize(market)) / 2;
}

/** Whole units for forex (as OANDA), 8 decimals for crypto. */
export function paperUnits(market: Market, units: number): number {
  const rounded = market.type === "forex" ? Math.floor(units) : Math.floor(units * 1e8) / 1e8;
  return rounded > 0 ? rounded : 0;
}

function fee(market: Market, value: number, costs: PaperCosts): number {
  return market.type === "crypto" ? (value * costs.cryptoFeePct) / 100 : 0;
}

/** Simulated account shared by the paper broker and the backtester. */
export class PaperAccount {
  constructor(
    readonly book: PaperBook,
    readonly costs: PaperCosts,
    readonly name = "paper",
  ) {}

  open(req: OpenRequest): Position {
    const { market } = req;
    const long = req.side === "long";
    const fill = fillPrice(market, long, req.price, this.costs);
    const entryFee = fee(market, req.units * fill, this.costs) * req.rate;
    this.book.balance -= entryFee;
    const away = long ? -1 : 1;
    return {
      id: `P${this.book.nextId++}`,
      broker: this.name,
      marketId: market.id,
      symbol: market.symbol,
      type: market.type,
      side: req.side,
      units: req.units,
      entryPrice: fill,
      stop: fill + away * req.stopDistance,
      takeProfit: req.takeProfitDistance === null ? null : fill - away * req.takeProfitDistance,
      openedAt: req.time,
      entryFee,
      extreme: fill,
    };
  }

  close(pos: Position, req: CloseRequest): ClosedTrade {
    const long = pos.side === "long";
    const exit = fillPrice(req.market, !long, req.price, this.costs);
    const exitFee = fee(req.market, pos.units * exit, this.costs) * req.rate;
    const gross = (exit - pos.entryPrice) * pos.units * (long ? 1 : -1) * req.rate;
    this.book.balance += gross - exitFee;
    return { ...pos, exitPrice: exit, closedAt: req.time, pnl: gross - exitFee - pos.entryFee, fees: pos.entryFee + exitFee, reason: req.reason };
  }

  equity(positions: Position[], marks: Map<string, PriceMark>): number {
    return positions.filter((p) => p.broker === this.name).reduce((sum, p) => sum + unrealized(p, marks.get(p.marketId)), this.book.balance);
  }
}

export class PaperBroker implements Broker {
  readonly realMoney = false;
  readonly managesStops = false;
  readonly account: PaperAccount;

  constructor(book: PaperBook, costs: PaperCosts, readonly name = "paper") {
    this.account = new PaperAccount(book, costs, name);
  }

  async init(): Promise<void> {}

  async equity(positions: Position[], marks: Map<string, PriceMark>): Promise<number> {
    return this.account.equity(positions, marks);
  }

  normalizeUnits(market: Market, units: number): number {
    return paperUnits(market, units);
  }

  async open(req: OpenRequest): Promise<Position> {
    return this.account.open(req);
  }

  async close(pos: Position, req: CloseRequest): Promise<ClosedTrade> {
    return this.account.close(pos, req);
  }

  async updateStop(pos: Position, stop: number): Promise<void> {
    pos.stop = stop;
  }
}
