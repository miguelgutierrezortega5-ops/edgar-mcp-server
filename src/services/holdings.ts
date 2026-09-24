/** Institutional holdings from Form 13F-HR (managers with over $100M in US equities). */
import { padCik, resolveCompany } from "./companies.js";
import { archiveUrl, getSubmissions, recentFilings, type Filing, type Submissions } from "./filings.js";
import { httpGet } from "./http.js";

export interface Holding {
  issuer: string;
  titleOfClass: string;
  cusip: string;
  /** Market value in US dollars. */
  value: number;
  shares: number;
  /** 'SH' = shares, 'PRN' = principal amount (bonds). */
  shareType: string;
  putCall?: string;
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'");

/** Text of the first <name> element, allowing a namespace prefix (some filers write <ns1:value>). */
function tag(xml: string, name: string): string | undefined {
  const v = xml.match(new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`, "i"))?.[1];
  return v === undefined ? undefined : decode(v.trim());
}

/**
 * Parse a 13F information table. Rows for the same security (split across sub-managers or
 * investment discretion) are merged. Values were reported in thousands of dollars until the
 * start of 2023; pass `valueMultiplier` 1000 for those filings.
 */
export function parseInfoTable(xml: string, valueMultiplier = 1): Holding[] {
  const merged = new Map<string, Holding>();
  for (const block of xml.match(/<(?:\w+:)?infoTable>[\s\S]*?<\/(?:\w+:)?infoTable>/gi) ?? []) {
    const cusip = (tag(block, "cusip") ?? "").toUpperCase();
    const titleOfClass = tag(block, "titleOfClass") ?? "";
    const putCall = tag(block, "putCall") || undefined;
    const key = `${cusip}|${titleOfClass}|${putCall ?? ""}`;
    const value = Number(tag(block, "value") ?? 0) * valueMultiplier;
    const shares = Number(tag(block, "sshPrnamt") ?? 0);
    const prev = merged.get(key);
    if (prev) {
      prev.value += value;
      prev.shares += shares;
    } else {
      merged.set(key, { issuer: tag(block, "nameOfIssuer") ?? "?", titleOfClass, cusip, value, shares, shareType: tag(block, "sshPrnamtType") ?? "SH", putCall });
    }
  }
  return [...merged.values()].sort((a, b) => b.value - a.value);
}

export interface Change {
  holding: Holding;
  status: "new" | "added" | "reduced" | "unchanged" | "exited";
  previousShares: number;
  /** Relative change in shares (null for new positions). */
  shareChange: number | null;
}

const key = (h: Holding) => `${h.cusip}|${h.titleOfClass}|${h.putCall ?? ""}`;

/** Compare two quarters' holdings position by position (by share count, not value). */
export function diffHoldings(current: Holding[], previous: Holding[]): { changes: Change[]; exited: Holding[] } {
  const prev = new Map(previous.map((h) => [key(h), h]));
  const changes = current.map((h): Change => {
    const p = prev.get(key(h));
    if (!p) return { holding: h, status: "new", previousShares: 0, shareChange: null };
    const shareChange = p.shares ? h.shares / p.shares - 1 : null;
    const status = h.shares > p.shares ? "added" : h.shares < p.shares ? "reduced" : "unchanged";
    return { holding: h, status, previousShares: p.shares, shareChange };
  });
  const now = new Set(current.map(key));
  return { changes, exited: previous.filter((h) => !now.has(key(h))) };
}

// ---------- EDGAR access ----------

interface EntityHit {
  _id: string;
  _source: { entity: string };
}

const has13F = (s: Submissions) => recentFilings(s).some((f) => f.form === "13F-HR");

/**
 * Resolve an investment manager (name or CIK) to a 13F filer. Most managers are not listed
 * companies, so names are looked up in EDGAR's entity search and the first match that files
 * 13F-HR wins.
 */
export async function resolveFiler(input: string): Promise<Submissions> {
  const q = input.trim();
  if (/^\d{1,10}$/.test(q)) return getSubmissions(padCik(q));

  const candidates: string[] = [];
  const listed = await resolveCompany(q).catch(() => undefined);
  if (listed && (listed.ticker === q.toUpperCase().replace(/\./g, "-") || listed.name.toLowerCase() === q.toLowerCase())) candidates.push(listed.cik);
  const res = await httpGet<{ hits: { hits: EntityHit[] } }>("efts", `/LATEST/search-index?keysTyped=${encodeURIComponent(q)}`, { ttl: 24 * 60 * 60 * 1000 });
  for (const h of res.hits.hits) if (/^\d+$/.test(h._id)) candidates.push(padCik(h._id));

  const names: string[] = [];
  for (const cik of [...new Set(candidates)].slice(0, 6)) {
    const s = await getSubmissions(cik).catch(() => undefined);
    if (!s) continue;
    if (has13F(s)) return s;
    names.push(s.name);
  }
  throw new Error(
    `No 13F filer found for '${input}'.${names.length ? ` Matches without 13F filings: ${names.join("; ")}.` : ""} ` +
      "Try the manager's legal name (e.g. 'Pershing Square Capital Management', 'Scion Asset Management') or its CIK.",
  );
}

export interface Report {
  filing: Filing;
  holdings: Holding[];
}

/** The 13F-HR filings (originals, newest first); amendments are ignored. */
export const thirteenFs = (s: Submissions) => recentFilings(s).filter((f) => f.form === "13F-HR");

export async function loadReport(sub: Submissions, filing: Filing): Promise<Report> {
  const index = await httpGet<{ directory: { item: { name: string; size?: string }[] } }>(
    "www",
    new URL(archiveUrl(sub.cik, filing.accessionNumber, "index.json")).pathname,
    { ttl: 7 * 24 * 60 * 60 * 1000 },
  );
  const xmls = index.directory.item.filter((i) => /\.xml$/i.test(i.name) && !/primary_doc\.xml$/i.test(i.name));
  const table = xmls.find((i) => /info|table/i.test(i.name)) ?? xmls.sort((a, b) => Number(b.size ?? 0) - Number(a.size ?? 0))[0];
  if (!table) throw new Error(`No information table found in 13F filing ${filing.accessionNumber}.`);
  const xml = await httpGet<string>("www", new URL(archiveUrl(sub.cik, filing.accessionNumber, table.name)).pathname, { as: "text", ttl: 7 * 24 * 60 * 60 * 1000 });
  // Since 3 January 2023, 13F values are in dollars; before, in thousands.
  return { filing, holdings: parseInfoTable(xml, filing.filingDate < "2023-01-03" ? 1000 : 1) };
}
