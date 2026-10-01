import type { ClosedTrade, Market, Position, PriceMark, Side } from "../types.js";

export interface OpenRequest {
  market: Market;
  side: Side;
  units: number;
  /** Latest market price (mid); the broker fills at its own price. */
  price: number;
  /** Quote-to-account currency rate. */
  rate: number;
  /** Stop and take-profit are placed at these distances from the actual fill. */
  stopDistance: number;
  takeProfitDistance: number | null;
  time: number;
}

export interface CloseRequest {
  market: Market;
  reason: string;
  /** Latest price, or the stop / take-profit level that triggered the exit. */
  price: number;
  rate: number;
  time: number;
}

export interface Broker {
  readonly name: string;
  /** True when orders move real money (not paper, sandbox or a demo account). */
  readonly realMoney: boolean;
  /** True when stop-loss and take-profit orders live on the broker; otherwise the bot watches them. */
  readonly managesStops: boolean;
  init(markets: Market[]): Promise<void>;
  /** Account value in account currency, including open positions. */
  equity(positions: Position[], marks: Map<string, PriceMark>): Promise<number>;
  /** Round units to what the venue accepts; 0 when below its minimum size. */
  normalizeUnits(market: Market, units: number, price: number): number;
  open(req: OpenRequest): Promise<Position>;
  close(pos: Position, req: CloseRequest): Promise<ClosedTrade>;
  updateStop(pos: Position, stop: number): Promise<void>;
  /** Brokers that manage stops report here the bot's positions they have closed. */
  reconcile?(positions: Position[]): Promise<ClosedTrade[]>;
}

export function unrealized(pos: Position, mark: PriceMark | undefined): number {
  if (!mark) return 0;
  return (mark.price - pos.entryPrice) * pos.units * (pos.side === "long" ? 1 : -1) * mark.rate;
}
