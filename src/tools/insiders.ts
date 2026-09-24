import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { companyField, resolveCompany } from "../services/companies.js";
import { archiveUrl, getSubmissions, recentFilings } from "../services/filings.js";
import { fmtNum, mdTable, render, responseFormatField } from "../services/format.js";
import { parseForm4 } from "../services/form4.js";
import { httpGet } from "../services/http.js";
import { registerReadTool } from "./register.js";

export function registerInsiderTools(server: McpServer): void {
  registerReadTool(
    server,
    "edgar_get_insider_trades",
    {
      title: "Get insider trades (Form 4)",
      description: `Get recent insider transactions from Form 4 filings (officers, directors, 10% owners): date, insider, role, transaction type, shares, price, value and shares owned afterwards, plus a summary of open-market buys vs sells.
Codes: P = open-market buy, S = open-market sale (the most informative); A = grant, M/X = option exercise, F = tax withholding, G = gift.`,
      inputSchema: {
        company: companyField,
        max_filings: z.number().int().min(1).max(40).default(15).describe("How many of the most recent Form 4 filings to parse (1-40, default 15)."),
        open_market_only: z.boolean().default(false).describe("Only open-market buys and sales (codes P and S)."),
        response_format: responseFormatField,
      },
    },
    async ({ company, max_filings, open_market_only, response_format }) => {
      const reg = await resolveCompany(company);
      const s = await getSubmissions(reg.cik);
      const form4s = recentFilings(s)
        .filter((f) => f.form === "4" || f.form === "4/A")
        .slice(0, max_filings);
      const parsed = await Promise.all(
        form4s.map(async (f) => {
          const xmlFile = f.primaryDocument.split("/").pop()!;
          const url = archiveUrl(reg.cik, f.accessionNumber, xmlFile);
          try {
            const xml = await httpGet<string>("www", new URL(url).pathname, { as: "text", ttl: 24 * 60 * 60 * 1000 });
            return parseForm4(xml, f.filingDate, url);
          } catch {
            return undefined;
          }
        }),
      );
      const failed = parsed.filter((p) => p === undefined).length;
      if (failed && failed === form4s.length) throw new Error(`Could not download any of ${s.name}'s last ${failed} Form 4 filings from the SEC. Try again shortly.`);
      const trades = parsed.flatMap((p) => p ?? []).filter((t) => !open_market_only || t.code === "P" || t.code === "S");
      const sum = (code: string) => trades.filter((t) => t.code === code).reduce((a, t) => ({ n: a.n + 1, shares: a.shares + (t.shares ?? 0), value: a.value + (t.value ?? 0) }), { n: 0, shares: 0, value: 0 });
      const summary = {
        filingsParsed: form4s.length - failed,
        filingsFailed: failed,
        from: form4s.at(-1)?.filingDate,
        to: form4s[0]?.filingDate,
        openMarketBuys: sum("P"),
        openMarketSales: sum("S"),
      };
      return render(response_format, { company: s.name, summary, trades }, (d) =>
        [
          `# ${d.company} — insider trades (Form 4)`,
          "",
          `Parsed ${d.summary.filingsParsed} filings (${d.summary.from ?? "–"} → ${d.summary.to ?? "–"})${d.summary.filingsFailed ? `; ${d.summary.filingsFailed} could not be downloaded` : ""}.`,
          `- **Open-market buys**: ${d.summary.openMarketBuys.n} trades, ${fmtNum(d.summary.openMarketBuys.shares)} shares, $${fmtNum(d.summary.openMarketBuys.value)}`,
          `- **Open-market sales**: ${d.summary.openMarketSales.n} trades, ${fmtNum(d.summary.openMarketSales.shares)} shares, $${fmtNum(d.summary.openMarketSales.value)}`,
          "",
          d.trades.length
            ? mdTable(
                ["Date", "Insider", "Role", "Type", "Shares", "Price", "Value", "Owned after", "10b5-1"],
                d.trades.map((t) => [t.date, t.insider, t.role, `${t.type}${t.acquiredDisposed ? ` (${t.acquiredDisposed})` : ""}`, fmtNum(t.shares), t.price ? t.price.toFixed(2) : "–", fmtNum(t.value), fmtNum(t.ownedAfter), t.plan10b5_1 ? "yes" : ""]),
              )
            : "_No matching non-derivative transactions._",
        ].join("\n"),
      );
    },
  );
}
