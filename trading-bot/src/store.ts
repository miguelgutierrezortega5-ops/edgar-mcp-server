import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PaperBook } from "./brokers/paper.js";
import type { RiskState } from "./risk.js";
import type { ClosedTrade, Position } from "./types.js";

export interface BotState {
  version: 1;
  paper: PaperBook & { startingBalance: number };
  positions: Position[];
  /** Start time of the last closed bar evaluated, per market. */
  lastBar: Record<string, number>;
  /** Risk limits state, per broker. */
  risk: Record<string, RiskState>;
  recentTrades: ClosedTrade[];
}

const CSV_HEADER = "cerrada,abierta,broker,mercado,lado,unidades,entrada,salida,pnl,comisiones,motivo\n";

export class Store {
  readonly statePath: string;
  readonly tradesPath: string;

  constructor(readonly dir: string) {
    this.statePath = join(dir, "state.json");
    this.tradesPath = join(dir, "trades.csv");
  }

  load(startingBalance: number): BotState {
    if (existsSync(this.statePath)) return JSON.parse(readFileSync(this.statePath, "utf8")) as BotState;
    return { version: 1, paper: { balance: startingBalance, startingBalance, nextId: 1 }, positions: [], lastBar: {}, risk: {}, recentTrades: [] };
  }

  /** Write to a temporary file and rename, so a crash never leaves a half-written state. */
  save(state: BotState): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.statePath);
  }

  appendTrade(t: ClosedTrade): void {
    mkdirSync(this.dir, { recursive: true });
    if (!existsSync(this.tradesPath)) writeFileSync(this.tradesPath, CSV_HEADER);
    const row = [
      new Date(t.closedAt).toISOString(),
      new Date(t.openedAt).toISOString(),
      t.broker,
      t.symbol,
      t.side,
      t.units,
      t.entryPrice,
      t.exitPrice,
      t.pnl.toFixed(2),
      t.fees.toFixed(2),
      `"${t.reason.replace(/"/g, "'")}"`,
    ];
    appendFileSync(this.tradesPath, row.join(",") + "\n");
  }
}
