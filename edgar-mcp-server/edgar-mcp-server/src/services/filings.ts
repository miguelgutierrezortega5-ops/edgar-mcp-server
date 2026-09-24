import { httpGet } from "./http.js";

export interface Submissions {
  cik: string;
  name: string;
  entityType?: string;
  sic?: string;
  sicDescription?: string;
  tickers?: string[];
  exchanges?: string[];
  ein?: string;
  category?: string;
  fiscalYearEnd?: string;
  stateOfIncorporation?: string;
  phone?: string;
  website?: string;
  investorWebsite?: string;
  addresses?: { business?: { street1?: string; city?: string; stateOrCountry?: string; stateOrCountryDescription?: string } };
  formerNames?: { name: string; from?: string; to?: string }[];
  filings: { recent: Record<string, (string | number)[]> };
}

export interface Filing {
  accessionNumber: string;
  form: string;
  filingDate: string;
  reportDate?: string;
  primaryDocument: string;
  description?: string;
  items?: string;
  url: string;
}

export function getSubmissions(cik: string): Promise<Submissions> {
  return httpGet<Submissions>("data", `/submissions/CIK${cik}.json`, { ttl: 10 * 60 * 1000 });
}

export const archiveUrl = (cik: string, accession: string, file: string) =>
  `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${file}`;

/** Recent filings (the SEC keeps roughly the latest 1,000 here), newest first. */
export function recentFilings(sub: Submissions): Filing[] {
  const r = sub.filings.recent;
  const n = (r.accessionNumber ?? []).length;
  const out: Filing[] = [];
  for (let i = 0; i < n; i++) {
    const accessionNumber = String(r.accessionNumber[i]);
    const primaryDocument = String(r.primaryDocument[i] ?? "");
    out.push({
      accessionNumber,
      form: String(r.form[i]),
      filingDate: String(r.filingDate[i]),
      reportDate: r.reportDate?.[i] ? String(r.reportDate[i]) : undefined,
      primaryDocument,
      description: r.primaryDocDescription?.[i] ? String(r.primaryDocDescription[i]) : undefined,
      items: r.items?.[i] ? String(r.items[i]) : undefined,
      url: archiveUrl(sub.cik, accessionNumber, primaryDocument),
    });
  }
  return out;
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…", bull: "•" };

/** Convert filing HTML (including inline XBRL) to readable plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<ix:header>[\s\S]*?<\/ix:header>/gi, "")
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " \t ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SECTION_PATTERNS: Record<string, { start: RegExp; end: RegExp }> = {
  business: { start: /item\s*1\.?\s*business/gi, end: /item\s*1a\.?\s*risk\s*factors/gi },
  risk_factors: { start: /item\s*1a\.?\s*risk\s*factors/gi, end: /item\s*1b\.?|item\s*1c\.?|item\s*2\.?\s*properties/gi },
  legal_proceedings: { start: /item\s*3\.?\s*legal\s*proceedings/gi, end: /item\s*4\.?/gi },
  mdna: { start: /item\s*7\.?\s*management[’'`s]*\s*discussion/gi, end: /item\s*7a\.?|item\s*8\.?\s*financial/gi },
  market_risk: { start: /item\s*7a\.?\s*quantitative/gi, end: /item\s*8\.?\s*financial/gi },
  financial_statements: { start: /item\s*8\.?\s*financial\s*statements/gi, end: /item\s*9\.?\s*changes/gi },
};
export const SECTIONS = Object.keys(SECTION_PATTERNS) as [string, ...string[]];

/**
 * Locate a 10-K section. Headings appear first in the table of contents, so pick the
 * occurrence followed by the longest stretch of text before the next section heading.
 */
export function findSection(text: string, section: string): { start: number; end: number } | undefined {
  const pat = SECTION_PATTERNS[section];
  if (!pat) return undefined;
  let best: { start: number; end: number } | undefined;
  for (const m of text.matchAll(pat.start)) {
    const from = m.index! + m[0].length;
    pat.end.lastIndex = from;
    const next = pat.end.exec(text);
    const end = next ? next.index : text.length;
    if (!best || end - m.index! > best.end - best.start) best = { start: m.index!, end };
  }
  return best;
}
