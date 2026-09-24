import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dateField, fmtNum, mdTable, render, responseFormatField } from "../services/format.js";
import { diffHoldings, loadReport, resolveFiler, thirteenFs } from "../services/holdings.js";
import { registerReadTool } from "./register.js";

const pct = (v: number | null) => (v === null ? "–" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);

export function registerHoldingsTools(server: McpServer): void {
  registerReadTool(
    server,
    "edgar_get_institutional_holdings",
    {
      title: "Get a fund manager's 13F portfolio",
      description: `Get the US equity portfolio an investment manager reports quarterly on Form 13F (required above $100M): positions by value, % of portfolio, shares, and the change versus the previous quarter (new, added, reduced, exited).
Works for hedge funds, mutual fund families, banks and insurers, e.g. 'Berkshire Hathaway', 'Pershing Square Capital Management', 'Scion Asset Management', 'Bridgewater Associates', or a CIK.
Notes: 13F shows long US-listed positions only (no shorts, cash or foreign shares), is filed up to 45 days after quarter end, and identifies securities by CUSIP. Amendments are ignored.`,
      inputSchema: {
        manager: z.string().min(2).max(100).describe("Manager name or SEC CIK, e.g. 'Pershing Square Capital Management' or '1336528'."),
        period: dateField("Quarter end to show, e.g. '2026-03-31'. Default: latest"),
        limit: z.number().int().min(1).max(200).default(25).describe("Positions to list, largest first (default 25)."),
        response_format: responseFormatField,
      },
    },
    async ({ manager, period, limit, response_format }) => {
      const sub = await resolveFiler(manager);
      const filings = thirteenFs(sub);
      const idx = period ? filings.findIndex((f) => f.reportDate === period) : 0;
      if (idx < 0) {
        const available = [...new Set(filings.map((f) => f.reportDate))].slice(0, 8).join(", ");
        throw new Error(`${sub.name} has no 13F-HR for the quarter ending ${period}. Recent quarters: ${available}.`);
      }
      const filing = filings[idx];
      const prevFiling = filings.slice(idx + 1).find((f) => f.reportDate !== filing.reportDate);
      const [current, previous] = await Promise.all([loadReport(sub, filing), prevFiling ? loadReport(sub, prevFiling).catch(() => undefined) : undefined]);

      const total = current.holdings.reduce((s, h) => s + h.value, 0);
      const { changes, exited } = diffHoldings(current.holdings, previous?.holdings ?? []);
      const count = (s: string) => changes.filter((c) => c.status === s).length;
      const top10 = current.holdings.slice(0, 10).reduce((s, h) => s + h.value, 0);
      const data = {
        manager: sub.name,
        cik: sub.cik,
        period: filing.reportDate,
        filed: filing.filingDate,
        previousPeriod: previous?.filing.reportDate,
        totalValue: total,
        positions: current.holdings.length,
        top10Share: total ? top10 / total : null,
        changes: previous ? { new: count("new"), added: count("added"), reduced: count("reduced"), unchanged: count("unchanged"), exited: exited.length } : undefined,
        holdings: changes.slice(0, limit).map((c) => ({
          issuer: c.holding.issuer,
          class: c.holding.titleOfClass,
          cusip: c.holding.cusip,
          putCall: c.holding.putCall,
          value: c.holding.value,
          weight: total ? c.holding.value / total : null,
          shares: c.holding.shares,
          status: previous ? c.status : undefined,
          shareChange: previous ? c.shareChange : undefined,
        })),
        exited: exited.slice(0, 15).map((h) => ({ issuer: h.issuer, class: h.titleOfClass, cusip: h.cusip, previousValue: h.value, previousShares: h.shares })),
      };

      return render(response_format, data, (d) =>
        [
          `# ${d.manager} — 13F portfolio, quarter ending ${d.period}`,
          "",
          `Filed ${d.filed} · CIK ${d.cik} · **${fmtNum(d.totalValue)} USD** in ${d.positions} positions · top 10 = ${fmtNum(d.top10Share, "%")} of the portfolio.`,
          d.changes
            ? `vs ${d.previousPeriod}: ${d.changes.new} new, ${d.changes.added} added, ${d.changes.reduced} reduced, ${d.changes.unchanged} unchanged, ${d.changes.exited} exited.`
            : "_No previous 13F to compare with._",
          "",
          mdTable(
            ["#", "Issuer", "Class", "CUSIP", "Value", "% port.", "Shares", "Change"],
            d.holdings.map((h, i) => [
              i + 1,
              `${h.issuer}${h.putCall ? ` (${h.putCall.toUpperCase()})` : ""}`,
              h.class,
              h.cusip,
              fmtNum(h.value),
              fmtNum(h.weight, "%"),
              fmtNum(h.shares),
              h.status === undefined ? "–" : h.status === "new" ? "NEW" : h.status === "unchanged" ? "=" : pct(h.shareChange ?? null),
            ]),
          ),
          d.exited.length
            ? ["", `**Exited since ${d.previousPeriod}**: ${d.exited.map((h) => `${h.issuer} (${fmtNum(h.previousValue)})`).join("; ")}`].join("\n")
            : "",
          "",
          "_Source: SEC Form 13F-HR. Long US-listed positions only; values in USD at quarter end (for PUT/CALL rows, the value of the underlying shares). Change = change in shares held._",
        ].join("\n"),
      );
    },
  );
}
