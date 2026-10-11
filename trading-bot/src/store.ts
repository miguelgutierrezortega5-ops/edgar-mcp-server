import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PaperBook } from "./brokers/paper.js";
import type { HorariaState } from "./horaria/hourly.js";
import { newProtectionState, type ProtectionState } from "./protections.js";
import type { RiskState } from "./risk.js";
import type { AssetClass, ClosedTrade, Position } from "./types.js";

export interface BotState {
  version: 1;
  /** One simulated account per asset class, as real crypto and forex accounts are separate. */
  papers: Record<AssetClass, PaperBook & { startingBalance: number; /** Last `paper.topUp` applied. */ topUp?: string }>;
  positions: Position[];
  /** Start time of the last closed bar evaluated, per market. */
  lastBar: Record<string, number>;
  /** Risk limits state, per broker. */
  risk: Record<string, RiskState>;
  recentTrades: ClosedTrade[];
  protections: ProtectionState;
  /** Set from Telegram (/pausa): no new trades until /reanudar. */
  manualPause?: boolean;
  /** Challenge 1's hourly trade. */
  horaria?: HorariaState;
}

const newBook = (balance: number) => ({ balance, startingBalance: balance, nextId: 1 });
export const paperName = (type: AssetClass) => (type === "crypto" ? "paper-cripto" : "paper-forex");

const CSV_HEADER = "cerrada,abierta,broker,mercado,lado,unidades,entrada,salida,pnl,comisiones,motivo\n";

export class Store {
  readonly statePath: string;
  readonly tradesPath: string;

  constructor(readonly dir: string) {
    this.statePath = join(dir, "state.json");
    this.tradesPath = join(dir, "trades.csv");
  }

  load(startingBalance: number): BotState {
    if (existsSync(this.statePath)) {
      const state = JSON.parse(readFileSync(this.statePath, "utf8")) as BotState & { paper?: PaperBook & { startingBalance: number } };
      // State files from earlier versions: one shared paper account and no protections.
      state.protections ??= newProtectionState();
      if (!state.papers) {
        state.papers = { crypto: state.paper ?? newBook(startingBalance), forex: newBook(startingBalance) };
        delete state.paper;
        for (const p of state.positions) if (p.broker === "paper") p.broker = paperName(p.type);
      }
      return state;
    }
    return { version: 1, papers: { crypto: newBook(startingBalance), forex: newBook(startingBalance) }, positions: [], lastBar: {}, risk: {}, recentTrades: [], protections: newProtectionState() };
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
