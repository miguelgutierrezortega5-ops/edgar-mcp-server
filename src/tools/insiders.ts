import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { companyField, resolveCompany } from "../services/companies.js";
import { archiveUrl, getSubmissions, recentFilings } from "../services/filings.js";
import { fmtNum, mdTable, render, responseFormatField } from "../services/format.js";
import { httpGet } from "../services/http.js";
import { registerReadTool } from "./register.js";

const CODES: Record<string, string> = {
  P: "Open-market buy", S: "Open-market sale", A: "Grant/award", M: "Option exercise", F: "Tax withholding",
  G: "Gift", D: "Disposed to issuer", C: "Conversion", X: "Option exercise (in the money)", J: "Other", W: "Will/inheritance",
};

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'");

/** Text of the first <name> element, or of its <value> child (Form 4 wraps most fields that way, often next to footnote refs). */
function tag(xml: string, name: string): string | undefined {
  const inner = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"))?.[1];
  if (inner === undefined) return undefined;
  const value = inner.match(/<value>([^<]*)<\/value>/i)?.[1] ?? inner;
  return decode(value.trim()) || undefined;
}
const blocks = (xml: string, name: string) => xml.match(new RegExp(`<${name}>[\\s\\S]*?</${name}>`, "gi")) ?? [];
const num = (s?: string) => (s === undefined || s === "" ? undefined : Number(s));

interface Trade {
  filed: string;
  insider: string;
  role: string;
  date?: string;
  code?: string;
  type: string;
  shares?: number;
  price?: number;
  value?: number;
  acquiredDisposed?: string;
  ownedAfter?: number;
  plan10b5_1: boolean;
  url: string;
}

function parseForm4(xml: string, filed: string, url: string): Trade[] {
  const owner = tag(xml, "rptOwnerName") ?? "Unknown";
  const roles = [
    tag(xml, "isDirector") === "1" || tag(xml, "isDirector") === "true" ? "Director" : "",
    tag(xml, "officerTitle") ?? (tag(xml, "isOfficer") === "1" ? "Officer" : ""),
    tag(xml, "isTenPercentOwner") === "1" ? "10% owner" : "",
  ].filter(Boolean);
  const plan = /<aff10b5One>\s*(1|true)\s*<\/aff10b5One>/i.test(xml) || /10b5-1/i.test(xml);
  return blocks(xml, "nonDerivativeTransaction").map((t) => {
    const shares = num(tag(t, "transactionShares"));
    const price = num(tag(t, "transactionPricePerShare"));
    const code = t.match(/<transactionCode>\s*([A-Z])\s*<\/transactionCode>/)?.[1];
    return {
      filed,
      insider: owner,
      role: roles.join(", ") || "–",
      date: tag(t, "transactionDate"),
      code,
      type: code ? (CODES[code] ?? code) : "–",
      shares,
      price,
      value: shares !== undefined && price ? shares * price : undefined,
      acquiredDisposed: tag(t, "transactionAcquiredDisposedCode"),
      ownedAfter: num(tag(t, "sharesOwnedFollowingTransaction")),
      plan10b5_1: plan,
      url,
    };
  });
}

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
            return [];
          }
        }),
      );
      const trades = parsed.flat().filter((t) => !open_market_only || t.code === "P" || t.code === "S");
      const sum = (code: string) => trades.filter((t) => t.code === code).reduce((a, t) => ({ n: a.n + 1, shares: a.shares + (t.shares ?? 0), value: a.value + (t.value ?? 0) }), { n: 0, shares: 0, value: 0 });
      const summary = {
        filingsParsed: form4s.length,
        from: form4s.at(-1)?.filingDate,
        to: form4s[0]?.filingDate,
        openMarketBuys: sum("P"),
        openMarketSales: sum("S"),
      };
      return render(response_format, { company: s.name, summary, trades }, (d) =>
        [
          `# ${d.company} — insider trades (Form 4)`,
          "",
          `Parsed ${d.summary.filingsParsed} filings (${d.summary.from ?? "–"} → ${d.summary.to ?? "–"}).`,
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
