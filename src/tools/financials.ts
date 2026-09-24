import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { companyField, resolveCompany } from "../services/companies.js";
import { fmtNum, mdTable, render, responseFormatField } from "../services/format.js";
import { httpGet } from "../services/http.js";
import { computeKeyMetrics, KEY_METRICS } from "../services/metrics.js";
import { buildStatement } from "../services/statements.js";
import { conceptSeries, findConcept, getCompanyFacts, type PeriodKind } from "../services/xbrl.js";
import { registerReadTool } from "./register.js";

const periodField = z.enum(["annual", "quarterly"]).default("annual").describe("'annual' (fiscal years, default) or 'quarterly' (discrete quarters).");
const maxPeriodsField = z.number().int().min(1).max(20).default(5).describe("Most recent N periods (1-20, default 5).");

const SPLIT_NOTE = "EPS and share counts are as last reported for each period and may not reflect later stock splits.";
const unitFmt = (unit: string) => (unit.includes("/shares") ? "per_share" : unit === "shares" ? "shares" : undefined);

export function registerFinancialTools(server: McpServer): void {
  registerReadTool(
    server,
    "edgar_get_financial_statement",
    {
      title: "Get financial statement (SEC XBRL)",
      description: `Get a company's income statement, balance sheet or cash flow statement from its SEC XBRL filings (10-K/10-Q; IFRS for 20-F/40-F filers), as line items × periods.
Values are as reported (latest filing wins, so restatements are reflected). Quarterly values that are only reported year-to-date (cash flows, fiscal Q4) are derived by subtraction and flagged.
The cash flow statement includes free cash flow (CFO − capex). For any tag not covered here use edgar_search_concepts + edgar_get_concept.`,
      inputSchema: {
        company: companyField,
        statement: z.enum(["income", "balance", "cashflow"]).describe("'income', 'balance' or 'cashflow'."),
        period: periodField,
        max_periods: maxPeriodsField,
        response_format: responseFormatField,
      },
    },
    async ({ company, statement, period, max_periods, response_format }) => {
      const reg = await resolveCompany(company);
      const facts = await getCompanyFacts(reg.cik);
      const t = buildStatement(facts, statement, period, max_periods);
      return render(response_format, { company: facts.entityName, cik: reg.cik, statement, ...t }, (d) => {
        if (!d.periods.length) return `No ${period} ${statement} data found in ${facts.entityName}'s XBRL filings.`;
        const title = { income: "Income statement", balance: "Balance sheet", cashflow: "Cash flow statement" }[statement];
        return [
          `# ${facts.entityName} — ${title} (${period}, ${d.currency ?? "reported currency"})`,
          "",
          mdTable(["Line item", ...d.periods], d.rows.map((r) => [r.label, ...r.values.map((v) => fmtNum(v, unitFmt(r.unit)))])),
          "",
          `_Columns are period end dates. ${d.derivedQuarters ? "Some quarterly values are derived from year-to-date totals. " : ""}${statement === "income" ? SPLIT_NOTE : ""}_`,
        ].join("\n");
      });
    },
  );

  registerReadTool(
    server,
    "edgar_get_key_metrics",
    {
      title: "Get key metrics and ratios",
      description: `Compute key metrics from SEC filings: revenue and YoY growth, gross/operating/net margin, diluted EPS and growth, free cash flow and FCF margin, SBC/revenue, ROE, ROA, current ratio, debt/equity, net cash, buybacks + dividends.
Best single call for a quick fundamental overview of a company.`,
      inputSchema: { company: companyField, period: periodField, max_periods: maxPeriodsField, response_format: responseFormatField },
    },
    async ({ company, period, max_periods, response_format }) => {
      const reg = await resolveCompany(company);
      const facts = await getCompanyFacts(reg.cik);
      const t = computeKeyMetrics(facts, period, max_periods);
      return render(response_format, { company: facts.entityName, cik: reg.cik, period, ...t }, (d) =>
        d.periods.length
          ? [
              `# ${facts.entityName} — key metrics (${period}, ${d.currency ?? "reported currency"})`,
              "",
              mdTable(["Metric", ...d.periods], d.metrics.map((m) => [m.label, ...m.values.map((v) => fmtNum(v, m.unit === "money" ? undefined : m.unit))])),
              "",
              `_Columns are period end dates. ${SPLIT_NOTE}_`,
            ].join("\n")
          : `No ${period} data found for ${facts.entityName}.`,
      );
    },
  );

  registerReadTool(
    server,
    "edgar_compare_companies",
    {
      title: "Compare companies side by side",
      description: `Compare 2-10 companies on key metrics for their latest fiscal year (or a given fiscal year): revenue, growth, margins, EPS, FCF, ROE, leverage, etc.
Fiscal years end on different dates across companies; the period end used for each company is shown.`,
      inputSchema: {
        companies: z.array(companyField).min(2).max(10).describe("Tickers, CIKs or names, e.g. ['KO','PEP','MNST']."),
        fiscal_year: z.number().int().min(2009).max(2100).optional().describe("Fiscal year = calendar year of the period end date. Default: latest available per company."),
        metrics: z.array(z.enum(KEY_METRICS.map((m) => m.key) as [string, ...string[]])).optional().describe("Subset of metric keys to show. Default: all."),
        response_format: responseFormatField,
      },
    },
    async ({ companies, fiscal_year, metrics, response_format }) => {
      const results = await Promise.all(
        companies.map(async (c) => {
          try {
            const reg = await resolveCompany(c);
            const facts = await getCompanyFacts(reg.cik);
            const t = computeKeyMetrics(facts, "annual", 20);
            const idx = fiscal_year === undefined ? t.periods.length - 1 : t.periods.findIndex((p) => p.startsWith(String(fiscal_year)));
            return { company: reg.ticker ?? facts.entityName, name: facts.entityName, periodEnd: t.periods[idx], currency: t.currency, values: Object.fromEntries(t.metrics.map((m) => [m.key, idx >= 0 ? m.values[idx] : null])) };
          } catch (e) {
            return { company: c, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      const shown = KEY_METRICS.filter((m) => !metrics || metrics.includes(m.key));
      return render(response_format, { fiscalYear: fiscal_year ?? "latest", companies: results }, (d) => {
        const ok = d.companies.filter((c): c is Extract<typeof c, { values: unknown }> => "values" in c);
        const errors = d.companies.filter((c) => "error" in c) as { company: string; error: string }[];
        return [
          `# Company comparison — ${fiscal_year ? `FY${fiscal_year}` : "latest fiscal year"}`,
          "",
          mdTable(
            ["Metric", ...ok.map((c) => c.company)],
            [
              ["_Period end_", ...ok.map((c) => c.periodEnd ?? "n/a")],
              ["_Currency_", ...ok.map((c) => c.currency ?? "–")],
              ...shown.map((m) => [m.label, ...ok.map((c) => fmtNum(c.values[m.key], m.unit === "money" ? undefined : m.unit))]),
            ],
          ),
          ...errors.map((e) => `\n- ${e.company}: ${e.error}`),
        ].join("\n");
      });
    },
  );

  registerReadTool(
    server,
    "edgar_search_concepts",
    {
      title: "Search a company's XBRL concepts",
      description: `Find XBRL concepts (tags) a company reports, by keyword in the tag name or label — e.g. 'backlog', 'deferred revenue', 'segment', 'lease', 'employees'. Returns the concept name, label, units and the latest value.
Then use edgar_get_concept for the full history.`,
      inputSchema: {
        company: companyField,
        query: z.string().min(2).max(100).describe("Keyword(s) matched against concept name and label; all words must match."),
        limit: z.number().int().min(1).max(100).default(25).describe("Maximum concepts (default 25)."),
        response_format: responseFormatField,
      },
    },
    async ({ company, query, limit, response_format }) => {
      const reg = await resolveCompany(company);
      const facts = await getCompanyFacts(reg.cik);
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const rows: { concept: string; label?: string; units: string; latestEnd?: string; latestValue?: number; latestFiled?: string }[] = [];
      for (const [taxonomy, concepts] of Object.entries(facts.facts)) {
        for (const [tag, c] of Object.entries(concepts)) {
          const hay = `${tag} ${c.label ?? ""}`.toLowerCase();
          if (!words.every((w) => hay.includes(w))) continue;
          const all = Object.values(c.units).flat();
          const latest = all.reduce((a, b) => (b.filed > a.filed || (b.filed === a.filed && b.end > a.end) ? b : a), all[0]);
          rows.push({ concept: `${taxonomy}:${tag}`, label: c.label, units: Object.keys(c.units).join(", "), latestEnd: latest?.end, latestValue: latest?.val, latestFiled: latest?.filed });
        }
      }
      rows.sort((a, b) => (b.latestFiled ?? "").localeCompare(a.latestFiled ?? ""));
      const shown = rows.slice(0, limit);
      return render(response_format, { total: rows.length, concepts: shown }, (d) =>
        d.concepts.length
          ? [`# ${facts.entityName} — concepts matching '${query}' (${d.concepts.length} of ${d.total})`, "", mdTable(["Concept", "Label", "Units", "Latest period end", "Latest value"], d.concepts.map((c) => [c.concept, c.label, c.units, c.latestEnd, fmtNum(c.latestValue)]))].join("\n")
          : `No concepts matching '${query}' in ${facts.entityName}'s XBRL data. Try a broader keyword.`,
      );
    },
  );

  registerReadTool(
    server,
    "edgar_get_concept",
    {
      title: "Get one XBRL concept's history",
      description: `Get the reported history of any XBRL concept for a company (e.g. 'us-gaap:RevenueRemainingPerformanceObligation', 'dei:EntityCommonStockSharesOutstanding', 'us-gaap:NumberOfEmployees' is rarely tagged — search first).
Annual/quarterly keep ~1-year/~1-quarter durations (quarters derived from YTD when needed); 'all' returns every distinct reported period.`,
      inputSchema: {
        company: companyField,
        concept: z.string().min(2).max(200).describe("Concept name, optionally with taxonomy prefix: 'us-gaap:Revenues', 'ifrs-full:Revenue', 'dei:EntityCommonStockSharesOutstanding'."),
        period: z.enum(["annual", "quarterly", "all"]).default("annual").describe("Which periods to keep."),
        unit: z.string().optional().describe("Unit to use when a concept has several (e.g. 'USD', 'EUR', 'shares', 'USD/shares')."),
        max_points: z.number().int().min(1).max(100).default(12).describe("Most recent N values (default 12)."),
        response_format: responseFormatField,
      },
    },
    async ({ company, concept, period, unit, max_points, response_format }) => {
      const reg = await resolveCompany(company);
      const facts = await getCompanyFacts(reg.cik);
      const found = findConcept(facts, concept);
      if (!found) throw new Error(`${facts.entityName} does not report '${concept}'. Use edgar_search_concepts to find the right tag.`);
      let points: { start?: string; end: string; val: number; form: string; filed: string; derived?: boolean }[];
      if (period === "all") {
        const u = unit && found.concept.units[unit] ? unit : Object.keys(found.concept.units)[0];
        const latest = new Map<string, (typeof found.concept.units)[string][number]>();
        for (const f of found.concept.units[u]) {
          const k = `${f.start ?? ""}|${f.end}`;
          if (!latest.has(k) || f.filed > latest.get(k)!.filed) latest.set(k, f);
        }
        points = [...latest.values()];
      } else {
        points = [...conceptSeries(facts, `${found.taxonomy}:${found.tag}`, period as PeriodKind, unit).values()];
      }
      points.sort((a, b) => a.end.localeCompare(b.end) || (a.start ?? "").localeCompare(b.start ?? ""));
      points = points.slice(-max_points);
      const units = Object.keys(found.concept.units);
      return render(response_format, { company: facts.entityName, concept: `${found.taxonomy}:${found.tag}`, label: found.concept.label, description: found.concept.description, units, points }, (d) =>
        [
          `# ${d.company} — ${d.label ?? d.concept}`,
          "",
          `\`${d.concept}\` · units: ${d.units.join(", ")}`,
          d.description ? `\n> ${d.description}\n` : "",
          mdTable(["Start", "End", "Value", "Form", "Filed"], d.points.map((p) => [p.start ?? "(instant)", p.end, `${fmtNum(p.val)}${p.derived ? " (derived)" : ""}`, p.form, p.filed])),
        ].join("\n"),
      );
    },
  );

  registerReadTool(
    server,
    "edgar_rank_companies",
    {
      title: "Rank all companies on one concept (XBRL frames)",
      description: `Rank every SEC filer on one XBRL concept for a calendar period (XBRL "frames"), e.g. largest revenues in CY2025, most cash at end of 2025.
Period formats: 'CY2025' (annual duration), 'CY2025Q4' (quarter duration), 'CY2025Q4I' (instant, for balance-sheet items).
Values are aligned to calendar periods by the SEC, so fiscal years that don't match the calendar map to the closest calendar period.`,
      inputSchema: {
        concept: z
          .string()
          .regex(/^(?:[A-Za-z][\w-]*:)?[A-Za-z]\w*$/, "Use a concept name such as 'us-gaap:Revenues' or 'Revenues'")
          .max(200)
          .describe("Concept, e.g. 'us-gaap:Revenues', 'us-gaap:NetIncomeLoss', 'us-gaap:CashAndCashEquivalentsAtCarryingValue'."),
        period: z.string().regex(/^CY\d{4}(Q[1-4]I?)?$/, "Use CY2025, CY2025Q4 or CY2025Q4I").describe("Calendar period."),
        unit: z
          .string()
          .regex(/^[A-Za-z0-9_]+(?:(?:\/|-per-)[A-Za-z0-9_]+)?$/, "Use a unit such as 'USD', 'shares' or 'USD/shares'")
          .default("USD")
          .describe("Unit, e.g. 'USD', 'USD/shares' (or 'USD-per-shares'), 'shares' (default USD)."),
        order: z.enum(["desc", "asc"]).default("desc").describe("Sort order (default largest first)."),
        limit: z.number().int().min(1).max(200).default(25).describe("How many companies to return (default 25)."),
        highlight: companyField.optional().describe("Also report this company's rank."),
        response_format: responseFormatField,
      },
    },
    async ({ concept, period, unit, order, limit, highlight, response_format }) => {
      const [taxonomy, tag] = concept.includes(":") ? concept.split(":", 2) : ["us-gaap", concept];
      const res = await httpGet<{ label?: string; pts: number; data: { cik: number; entityName: string; loc?: string; end: string; val: number; accn: string }[] }>(
        "data",
        `/api/xbrl/frames/${taxonomy}/${tag}/${unit.replace("/", "-per-")}/${period}.json`,
        { ttl: 6 * 60 * 60 * 1000 },
      );
      const sorted = [...res.data].sort((a, b) => (order === "desc" ? b.val - a.val : a.val - b.val));
      let mine: { rank: number; entityName: string; val: number } | undefined;
      if (highlight) {
        const reg = await resolveCompany(highlight);
        const i = sorted.findIndex((r) => r.cik === Number(reg.cik));
        if (i >= 0) mine = { rank: i + 1, entityName: sorted[i].entityName, val: sorted[i].val };
      }
      const top = sorted.slice(0, limit).map((r, i) => ({ rank: i + 1, entityName: r.entityName, cik: r.cik, location: r.loc, end: r.end, value: r.val }));
      return render(response_format, { concept: `${taxonomy}:${tag}`, label: res.label, period, unit, companiesReporting: res.pts, highlight: mine, top }, (d) =>
        [
          `# ${d.label ?? d.concept} — ${period} (${unit})`,
          "",
          `${d.companiesReporting} companies report this concept (values as filed; extreme outliers are usually tagging errors in the filing).${d.highlight ? ` **${d.highlight.entityName}** ranks #${d.highlight.rank} with ${fmtNum(d.highlight.val)}.` : highlight ? ` ${highlight} does not report it for this period.` : ""}`,
          "",
          mdTable(["#", "Company", "Location", "Period end", "Value"], d.top.map((r) => [r.rank, r.entityName, r.location, r.end, fmtNum(r.value)])),
        ].join("\n"),
      );
    },
  );
}
