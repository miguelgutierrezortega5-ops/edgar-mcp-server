import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ResponseFormat } from "../constants.js";
import { companyField, loadRegistrants, padCik, resolveCompany } from "../services/companies.js";
import { archiveUrl, findSection, getSubmissions, htmlToText, recentFilings, SECTIONS } from "../services/filings.js";
import { dateField, mdTable, render, responseFormatField, textResult } from "../services/format.js";
import { cached, httpGet } from "../services/http.js";
import { registerReadTool } from "./register.js";

export function registerCompanyTools(server: McpServer): void {
  registerReadTool(
    server,
    "edgar_search_companies",
    {
      title: "Search SEC registrants",
      description: `Find companies that file with the SEC (≈10,000 listed registrants) by ticker or name. Returns ticker, name, CIK and exchange.
Use it when you are unsure of a ticker; most other tools accept a ticker, CIK or name directly.`,
      inputSchema: {
        query: z.string().min(1).max(100).describe("Ticker or part of the company name, e.g. 'coca', 'BRK'."),
        limit: z.number().int().min(1).max(100).default(20).describe("Maximum results (default 20)."),
        response_format: responseFormatField,
      },
    },
    async ({ query, limit, response_format }) => {
      const q = query.trim().toLowerCase();
      const all = await loadRegistrants();
      const scored = all
        .map((r) => {
          const t = (r.ticker ?? "").toLowerCase();
          const n = r.name.toLowerCase();
          const score = t === q.replace(/\./g, "-") ? 0 : t.startsWith(q) ? 1 : n.startsWith(q) ? 2 : n.includes(q) ? 3 : t.includes(q) ? 4 : 99;
          return { r, score };
        })
        .filter((x) => x.score < 99)
        .sort((a, b) => a.score - b.score)
        .slice(0, limit)
        .map((x) => x.r);
      return render(response_format, scored, (d) =>
        d.length ? mdTable(["Ticker", "Name", "CIK", "Exchange"], d.map((r) => [r.ticker, r.name, r.cik, r.exchange])) : `No SEC registrants match '${query}'.`,
      );
    },
  );

  registerReadTool(
    server,
    "edgar_get_company_info",
    {
      title: "Get SEC company info",
      description: `Get a company's SEC profile: legal name, tickers/exchanges, CIK, SIC industry, filer category, fiscal year end, state of incorporation, address, former names, and its latest annual/quarterly reports.`,
      inputSchema: { company: companyField, response_format: responseFormatField },
    },
    async ({ company, response_format }) => {
      const reg = await resolveCompany(company);
      const s = await getSubmissions(reg.cik);
      const filings = recentFilings(s);
      const latest = (re: RegExp) => filings.find((f) => re.test(f.form));
      const data = {
        name: s.name,
        cik: reg.cik,
        tickers: s.tickers,
        exchanges: s.exchanges,
        sic: s.sic,
        industry: s.sicDescription,
        category: s.category,
        entityType: s.entityType,
        fiscalYearEnd: s.fiscalYearEnd ? `${s.fiscalYearEnd.slice(0, 2)}-${s.fiscalYearEnd.slice(2)}` : undefined,
        stateOfIncorporation: s.stateOfIncorporation,
        address: s.addresses?.business,
        phone: s.phone,
        website: s.website || s.investorWebsite || undefined,
        formerNames: s.formerNames,
        latestAnnualReport: latest(/^(10-K|20-F|40-F)$/),
        latestQuarterlyReport: latest(/^10-Q$/),
      };
      return render(response_format, data, (d) =>
        [
          `# ${d.name}`,
          "",
          `- **Tickers**: ${d.tickers?.map((t, i) => `${t} (${d.exchanges?.[i] ?? "?"})`).join(", ") || "–"}`,
          `- **CIK**: ${d.cik}`,
          `- **Industry (SIC ${d.sic ?? "–"})**: ${d.industry ?? "–"}`,
          `- **Filer category**: ${d.category ?? "–"}`,
          `- **Fiscal year end (MM-DD)**: ${d.fiscalYearEnd ?? "–"}`,
          `- **Incorporated in**: ${d.stateOfIncorporation ?? "–"}`,
          `- **HQ**: ${[d.address?.street1, d.address?.city, d.address?.stateOrCountryDescription ?? d.address?.stateOrCountry].filter(Boolean).join(", ") || "–"}`,
          d.website ? `- **Website**: ${d.website}` : "",
          d.formerNames?.length ? `- **Former names**: ${d.formerNames.map((f) => f.name).join("; ")}` : "",
          "",
          `**Latest annual report**: ${d.latestAnnualReport ? `${d.latestAnnualReport.form} filed ${d.latestAnnualReport.filingDate} (period ${d.latestAnnualReport.reportDate}) — accession ${d.latestAnnualReport.accessionNumber}` : "–"}`,
          `**Latest quarterly report**: ${d.latestQuarterlyReport ? `10-Q filed ${d.latestQuarterlyReport.filingDate} (period ${d.latestQuarterlyReport.reportDate}) — accession ${d.latestQuarterlyReport.accessionNumber}` : "–"}`,
        ]
          .filter((l) => l !== "")
          .join("\n"),
      );
    },
  );

  registerReadTool(
    server,
    "edgar_list_filings",
    {
      title: "List SEC filings",
      description: `List a company's SEC filings, newest first, with form type, dates, accession number and document URL.
Common forms: 10-K (annual), 10-Q (quarterly), 8-K (material events; see 'items', e.g. 2.02 = earnings), DEF 14A (proxy/executive pay), 4 (insider trades), S-1 (IPO), 13D/13G (5%+ holders), 20-F/6-K (foreign issuers).`,
      inputSchema: {
        company: companyField,
        forms: z.array(z.string().min(1)).max(20).optional().describe("Only these form types, e.g. ['10-K','10-Q','8-K']. Amendments ('10-K/A') match their base form."),
        start_date: dateField("Filed on/after"),
        end_date: dateField("Filed on/before"),
        limit: z.number().int().min(1).max(200).default(20).describe("Maximum filings (default 20)."),
        response_format: responseFormatField,
      },
    },
    async ({ company, forms, start_date, end_date, limit, response_format }) => {
      const reg = await resolveCompany(company);
      const s = await getSubmissions(reg.cik);
      const wanted = forms?.map((f) => f.toUpperCase());
      const rows = recentFilings(s)
        .filter((f) => !wanted || wanted.includes(f.form.toUpperCase()) || wanted.includes(f.form.toUpperCase().replace(/\/A$/, "")))
        .filter((f) => (!start_date || f.filingDate >= start_date) && (!end_date || f.filingDate <= end_date))
        .slice(0, limit);
      return render(response_format, rows, (d) =>
        d.length
          ? [
              `# ${s.name} — filings`,
              "",
              mdTable(["Filed", "Form", "Period", "Items / description", "Accession", "URL"], d.map((f) => [f.filingDate, f.form, f.reportDate, f.items || f.description, f.accessionNumber, f.url])),
              "",
              "_Read a document with edgar_read_filing(company, accession_number)._",
            ].join("\n")
          : "No filings match those filters (only the ~1,000 most recent filings are indexed here).",
      );
    },
  );

  registerReadTool(
    server,
    "edgar_read_filing",
    {
      title: "Read an SEC filing",
      description: `Read the text of a filing's main document (10-K, 10-Q, 8-K, proxy, S-1...) or one of its exhibits. Long documents are paginated by characters.
- \`section\` jumps to a 10-K/10-Q section: business, risk_factors, legal_proceedings, mdna, market_risk, financial_statements.
- \`find\` jumps to the first occurrence of a phrase (e.g. 'share repurchase', 'backlog').
- \`document\` reads another file of the filing, e.g. the earnings press release exhibit of an 8-K ('msft-ex99_1.htm'); the header lists the filing's exhibits.
- Otherwise continue with \`offset\` as instructed at the end of each chunk.
Omit accession_number to read the latest 10-K (or 20-F/40-F).`,
      inputSchema: {
        company: companyField,
        accession_number: z.string().regex(/^\d{10}-\d{2}-\d{6}$/, "Format 0000000000-00-000000").optional().describe("Accession number from edgar_list_filings, e.g. '0001193125-26-323660'. Default: latest annual report."),
        document: z.string().regex(/^[\w.-]+\.(htm|html|txt|xml)$/i, "A file name such as 'ex99_1.htm'").optional().describe("File name within the filing to read instead of the main document (see the exhibit list in the header)."),
        section: z.enum(SECTIONS).optional().describe("10-K section to read."),
        find: z.string().min(2).max(200).optional().describe("Case-insensitive phrase to jump to."),
        offset: z.number().int().min(0).default(0).describe("Character offset to start reading from."),
        max_chars: z.number().int().min(1000).max(20000).default(12000).describe("Maximum characters to return (default 12000)."),
      },
    },
    async ({ company, accession_number, document, section, find, offset, max_chars }) => {
      const reg = await resolveCompany(company);
      const s = await getSubmissions(reg.cik);
      const filings = recentFilings(s);
      const filing = accession_number ? filings.find((f) => f.accessionNumber === accession_number) : filings.find((f) => /^(10-K|20-F|40-F)$/.test(f.form));
      if (!filing) throw new Error(accession_number ? `Accession ${accession_number} not found among ${s.name}'s recent filings. Use edgar_list_filings.` : `No annual report found for ${s.name}.`);

      // Exhibits: other HTML/text documents in the filing folder (skip XBRL viewer pages R1.htm…).
      const index = await httpGet<{ directory: { item: { name: string; size?: string }[] } }>("www", new URL(archiveUrl(reg.cik, filing.accessionNumber, "index.json")).pathname, { ttl: 24 * 60 * 60 * 1000 }).catch(() => undefined);
      const exhibits = (index?.directory.item ?? [])
        .map((i) => i.name)
        .filter((n) => /\.(htm|html|txt)$/i.test(n) && n !== filing.primaryDocument && !/^R\d+\.htm$/i.test(n) && !n.startsWith(filing.accessionNumber));
      if (document && !exhibits.includes(document) && document !== filing.primaryDocument) {
        throw new Error(`'${document}' is not in this filing. Available documents: ${[filing.primaryDocument, ...exhibits].join(", ")}.`);
      }
      const url = document ? archiveUrl(reg.cik, filing.accessionNumber, document) : filing.url;
      // Cache the extracted text, not the HTML: paging through a 10-K then skips re-parsing megabytes of markup.
      const text = await cached(`filing-text:${url}`, 60 * 60 * 1000, async () => {
        const plain = htmlToText(await httpGet<string>("www", new URL(url).pathname, { as: "text" }));
        return { value: plain, size: plain.length };
      });

      let start = offset;
      let end = text.length;
      let note = "";
      if (section && offset === 0) {
        const loc = findSection(text, section);
        if (!loc) throw new Error(`Section '${section}' not found in this ${filing.form}. Try \`find\` with a phrase instead.`);
        [start, end] = [loc.start, loc.end];
        note = `Section '${section}' spans characters ${loc.start}–${loc.end}.`;
      } else if (find && offset === 0) {
        const idx = text.toLowerCase().indexOf(find.toLowerCase());
        if (idx < 0) throw new Error(`'${find}' does not appear in this document.`);
        start = Math.max(0, idx - 200);
        note = `First match for '${find}' at character ${idx}.`;
      }
      const chunk = text.slice(start, Math.min(end, start + max_chars));
      const next = start + chunk.length;
      const more = next < text.length ? `\n\n[Continue with offset=${next} (document has ${text.length} characters).]` : "\n\n[End of document.]";
      const others = [filing.primaryDocument, ...exhibits].filter((n) => n !== (document ?? filing.primaryDocument));
      const exhibitLine = others.length && offset === 0 ? `Other documents in this filing (use \`document\`): ${others.join(", ")}\n` : "";
      return textResult(
        `# ${s.name} — ${filing.form} filed ${filing.filingDate}${document ? ` — ${document}` : ""}\nSource: ${url}\n${exhibitLine}${note ? `${note}\n` : ""}\n${chunk}${more}`,
      );
    },
  );

  registerReadTool(
    server,
    "edgar_full_text_search",
    {
      title: "Full-text search of SEC filings",
      description: `Search the full text of all SEC filings since 2001 (EDGAR full-text search). Supports exact phrases in double quotes, e.g. '"supply chain" tariffs'.
Filter by form types, date range and company. Returns company, form, filing date, and document URL for each hit (read it with edgar_read_filing or open the URL).`,
      inputSchema: {
        query: z.string().min(2).max(300).describe("Search terms; wrap exact phrases in double quotes."),
        forms: z.array(z.string()).max(10).optional().describe("Form types, e.g. ['10-K','8-K']."),
        company: companyField.optional(),
        start_date: dateField("Filed on/after"),
        end_date: dateField("Filed on/before"),
        page: z.number().int().min(1).max(50).default(1).describe("Result page (100 hits per page on the SEC side; trimmed by limit)."),
        limit: z.number().int().min(1).max(100).default(20).describe("Maximum hits to show (default 20)."),
        response_format: responseFormatField,
      },
    },
    async ({ query, forms, company, start_date, end_date, page, limit, response_format }) => {
      const params = new URLSearchParams({ q: query });
      if (forms?.length) params.set("forms", forms.join(","));
      if (company) params.set("ciks", (await resolveCompany(company)).cik);
      if (start_date || end_date) {
        params.set("dateRange", "custom");
        params.set("startdt", start_date ?? "2001-01-01");
        params.set("enddt", end_date ?? new Date().toISOString().slice(0, 10));
      }
      if (page > 1) params.set("from", String((page - 1) * 100));
      const res = await httpGet<{ hits: { total: { value: number; relation?: string }; hits: { _id: string; _source: { ciks: string[]; display_names: string[]; form: string; file_date: string; period_ending?: string; file_type?: string; file_description?: string; adsh: string } }[] } }>(
        "efts",
        `/LATEST/search-index?${params}`,
      );
      const hits = res.hits.hits.slice(0, limit).map((h) => {
        const file = h._id.split(":")[1];
        const cik = h._source.ciks[0];
        return {
          company: h._source.display_names[0],
          form: h._source.form,
          filed: h._source.file_date,
          periodEnding: h._source.period_ending,
          document: h._source.file_description || h._source.file_type,
          accessionNumber: h._source.adsh,
          url: archiveUrl(padCik(cik), h._source.adsh, file),
        };
      });
      const total = `${res.hits.total.value}${res.hits.total.relation === "gte" ? "+" : ""}`;
      return render(response_format, { total, page, hits }, (d) =>
        d.hits.length
          ? [`# Full-text search: ${query}`, "", `${d.total} matching documents (page ${d.page}).`, "", mdTable(["Filed", "Company", "Form", "Document", "URL"], d.hits.map((h) => [h.filed, h.company, h.form, h.document, h.url]))].join("\n")
          : `No filings match ${query}.`,
      );
    },
  );
}
